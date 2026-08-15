import { PROMPT_VERSIONS } from '../prompts.js';
import type { CaptionGenerator, CaptionRequest, GeneratedCaption } from '../types.js';

const BASE_HASHTAGS = [
  'motivation',
  'dailyreminder',
  'gentleprogress',
  'smallsteps',
  'sketchbook',
  'pencilart',
  'calmmindset',
];

export class MockCaptionGenerator implements CaptionGenerator {
  public constructor(private readonly modelId = 'mock-text-v1') {}

  public async generate(request: CaptionRequest): Promise<GeneratedCaption> {
    const handle = request.brandHandle ? `\n\n${request.brandHandle}` : '';
    return {
      caption: `${request.quote}.${handle}`,
      altText: `A hand-drawn pencil sketch on cream paper showing ${request.sceneConcept}.`,
      hashtags: BASE_HASHTAGS.slice(0, 6),
      provider: 'mock',
      modelId: this.modelId,
      promptVersion: PROMPT_VERSIONS.caption,
    };
  }
}
