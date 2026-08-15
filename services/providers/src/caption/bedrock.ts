import { z } from 'zod';

import { BedrockClient, extractJsonObject } from '../bedrock-client.js';
import { CAPTION_SYSTEM_PROMPT, PROMPT_VERSIONS } from '../prompts.js';
import type { CaptionGenerator, CaptionRequest, GeneratedCaption } from '../types.js';

const responseSchema = z.object({
  caption: z.string().min(1).max(2_000),
  altText: z.string().min(1).max(1_000),
  hashtags: z.array(z.string().min(2).max(40)).min(1).max(10),
});

const sanitiseHashtag = (tag: string): string =>
  tag.replace(/^#+/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

export class BedrockCaptionGenerator implements CaptionGenerator {
  public constructor(
    private readonly options: { client: BedrockClient; modelId: string },
  ) {}

  public async generate(request: CaptionRequest): Promise<GeneratedCaption> {
    const raw = await this.options.client.generateText({
      modelId: this.options.modelId,
      systemPrompt: CAPTION_SYSTEM_PROMPT,
      userPrompt: `Quote: ${request.quote}\nIllustration: ${request.sceneConcept}`,
      maxTokens: 500,
      temperature: 0.7,
    });

    const parsed = responseSchema.parse(extractJsonObject(raw));
    const handle = request.brandHandle ? `\n\n${request.brandHandle}` : '';

    return {
      caption: `${parsed.caption.trim()}${handle}`,
      altText: parsed.altText.trim(),
      hashtags: parsed.hashtags.map(sanitiseHashtag).filter(Boolean),
      provider: 'bedrock',
      modelId: this.options.modelId,
      promptVersion: PROMPT_VERSIONS.caption,
    };
  }
}
