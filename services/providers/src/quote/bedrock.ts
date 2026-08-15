import { z } from 'zod';

import { BedrockClient, extractJsonObject } from '../bedrock-client.js';
import { PROMPT_VERSIONS, QUOTE_SYSTEM_PROMPT, buildQuoteUserPrompt } from '../prompts.js';
import type { GeneratedQuote, QuoteGenerator, QuoteRequest } from '../types.js';

const responseSchema = z.object({
  quote: z.string().min(1),
  sceneConcept: z.string().min(1),
  safetyRationale: z.string().min(1),
});

export interface BedrockQuoteGeneratorOptions {
  client: BedrockClient;
  /** Supplied by configuration. Never defaulted to a specific model. */
  modelId: string;
}

export class BedrockQuoteGenerator implements QuoteGenerator {
  public constructor(private readonly options: BedrockQuoteGeneratorOptions) {}

  public async generate(request: QuoteRequest): Promise<GeneratedQuote> {
    const raw = await this.options.client.generateText({
      modelId: this.options.modelId,
      systemPrompt: QUOTE_SYSTEM_PROMPT,
      userPrompt: buildQuoteUserPrompt({
        minWords: request.minWords,
        maxWords: request.maxWords,
        avoidPhrases: request.avoidPhrases,
        seed: request.seed,
      }),
      maxTokens: 400,
      temperature: 0.95,
    });

    const parsed = responseSchema.parse(extractJsonObject(raw));

    return {
      text: parsed.quote.trim(),
      sceneConcept: parsed.sceneConcept.trim(),
      safetyRationale: parsed.safetyRationale.trim(),
      provider: 'bedrock',
      modelId: this.options.modelId,
      promptVersion: PROMPT_VERSIONS.quote,
    };
  }
}
