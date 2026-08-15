import { describe, expect, it } from 'vitest';

import { DEFAULT_TEXT_SAFE_AREAS } from '@mrp/providers';
import {
  buildProbeCommand,
  buildRenderCommand,
  buildThumbnailCommand,
  escapeFilterValue,
  kenBurnsFromSeed,
  layoutQuote,
} from '@mrp/renderer';

const baseInput = {
  imagePath: '/work/job-1/source.png',
  outputPath: '/work/job-1/reel.mp4',
  fontPath: '/opt/fonts/Caveat.ttf',
  quote: 'Begin again as many times as the morning allows',
  textSafeArea: DEFAULT_TEXT_SAFE_AREAS.upper_left,
  durationSeconds: 14,
  seed: 123_456,
  workDir: '/work/job-1',
};

describe('buildRenderCommand', () => {
  it('produces a stable command for a given input', () => {
    expect(buildRenderCommand(baseInput).args).toMatchSnapshot();
  });

  it('produces a stable filter graph', () => {
    expect(buildRenderCommand(baseInput).filterGraph).toMatchSnapshot();
  });

  it('does not loop the still input, which would square the frame count', () => {
    const { args } = buildRenderCommand(baseInput);
    // `-loop 1` combined with zoompan's `d` makes ffmpeg emit d frames per input
    // frame. The still must be a single frame; zoompan generates the rest.
    expect(args).not.toContain('-loop');
    expect(args.filter((arg) => arg === '-i')).toHaveLength(2);
  });

  it('always emits 1080x1920 h264 + 48kHz aac', () => {
    const { args, filterGraph } = buildRenderCommand(baseInput);
    expect(filterGraph).toContain('s=1080x1920');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args).toContain('yuv420p');
    expect(args).toContain('+faststart');
  });

  it('renders a silent AAC track when there is no approved music', () => {
    const { args } = buildRenderCommand(baseInput);
    expect(args.join(' ')).toContain('anullsrc');
    // Still a real audio stream: both platforms expect one.
    expect(args).toContain('-c:a');
  });

  it('mixes licensed music at the configured volume with fades', () => {
    const { args, filterGraph } = buildRenderCommand({
      ...baseInput,
      musicPath: '/work/job-1/music.bin',
      musicVolumeDb: -20,
    });
    expect(args).toContain('/work/job-1/music.bin');
    expect(args.join(' ')).not.toContain('anullsrc');
    expect(filterGraph).toContain('volume=-20dB');
    expect(filterGraph).toContain('afade=t=out');
  });

  it('writes each wrapped line to its own text file instead of escaping inline', () => {
    const { textFiles, filterGraph } = buildRenderCommand(baseInput);
    expect(textFiles.length).toBeGreaterThan(1);
    expect(textFiles.map((file) => file.content).join(' ')).toBe(baseInput.quote);
    for (const file of textFiles) expect(filterGraph).toContain(file.path.replace(/:/g, '\\:'));
  });

  it('skips the drawn quote in embedded_ai mode', () => {
    const { filterGraph, textFiles } = buildRenderCommand({ ...baseInput, drawQuote: false });
    expect(filterGraph).not.toContain('drawtext');
    expect(textFiles).toHaveLength(0);
  });

  it('adds the brand handle only when configured', () => {
    expect(buildRenderCommand(baseInput).filterGraph.match(/drawtext/g)).toHaveLength(4);
    const withHandle = buildRenderCommand({ ...baseInput, brandHandle: '@example' });
    expect(withHandle.filterGraph.match(/drawtext/g)).toHaveLength(5);
    expect(withHandle.textFiles.some((file) => file.content === '@example')).toBe(true);
  });

  it('fades in and out', () => {
    const { filterGraph } = buildRenderCommand(baseInput);
    expect(filterGraph).toContain('fade=t=in:st=0');
    expect(filterGraph).toContain('fade=t=out:st=13.40');
  });
});

describe('kenBurnsFromSeed', () => {
  it('is deterministic', () => {
    expect(kenBurnsFromSeed(99)).toEqual(kenBurnsFromSeed(99));
    expect(kenBurnsFromSeed(99)).not.toEqual(kenBurnsFromSeed(100));
  });

  it('keeps the motion gentle', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const motion = kenBurnsFromSeed(seed);
      const travel = Math.abs(motion.zoomEnd - motion.zoomStart);
      expect(travel).toBeGreaterThan(0.05);
      expect(travel).toBeLessThan(0.12);
      expect(Math.abs(motion.panX)).toBeLessThanOrEqual(0.4);
      expect(Math.abs(motion.panY)).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('layoutQuote', () => {
  it('keeps the text block inside the reserved area', () => {
    const layout = layoutQuote({
      text: baseInput.quote,
      area: DEFAULT_TEXT_SAFE_AREAS.upper_left,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
    const area = DEFAULT_TEXT_SAFE_AREAS.upper_left;
    expect(layout.y).toBeGreaterThanOrEqual(area.y * 1920);
    expect(layout.y + layout.blockHeight).toBeLessThanOrEqual((area.y + area.height) * 1920 + 1);
    expect(layout.x + layout.blockWidth).toBeLessThanOrEqual((area.x + area.width) * 1080 + 1);
  });

  it('shrinks the font for a longer line rather than overflowing', () => {
    const short = layoutQuote({
      text: 'Start small today',
      area: DEFAULT_TEXT_SAFE_AREAS.upper_left,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
    const long = layoutQuote({
      text: 'Start small today and keep the quiet promise you made to yourself last week',
      area: DEFAULT_TEXT_SAFE_AREAS.upper_left,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
    expect(long.fontSize).toBeLessThanOrEqual(short.fontSize);
    expect(long.lines.length).toBeGreaterThan(short.lines.length);
  });

  it('never splits a word', () => {
    const layout = layoutQuote({
      text: baseInput.quote,
      area: DEFAULT_TEXT_SAFE_AREAS.upper_middle,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
    expect(layout.lines.join(' ')).toBe(baseInput.quote);
  });
});

describe('escaping and probe', () => {
  it('escapes filter option values', () => {
    expect(escapeFilterValue("C:/fonts/it's.ttf")).toBe("C\\:/fonts/it\\'s.ttf");
  });

  it('builds a thumbnail and probe command', () => {
    expect(buildThumbnailCommand('/a/reel.mp4', '/a/cover.jpg')).toContain('-frames:v');
    expect(buildProbeCommand('/a/reel.mp4')).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/a/reel.mp4',
    ]);
  });
});
