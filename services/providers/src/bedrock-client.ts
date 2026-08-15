import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

import { NonRetryableError, RetryableError } from '@mrp/shared';

/**
 * Thin Bedrock wrapper.
 *
 * Model ids are always supplied by configuration. Nothing in this file assumes a
 * particular model family is enabled in a particular region, because that varies
 * per account - see docs/meta-onboarding.md and the README prerequisites.
 */

const THROTTLE_ERRORS = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'InternalServerException',
]);

const FATAL_ERRORS = new Set([
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
  'ModelNotReadyException',
]);

export const classifyBedrockError = (error: unknown): Error => {
  const name = (error as { name?: string }).name ?? 'UnknownError';
  const message = (error as { message?: string }).message ?? 'Bedrock call failed';
  if (THROTTLE_ERRORS.has(name)) {
    return new RetryableError(`Bedrock transient failure: ${name}`, { code: name, cause: error });
  }
  if (FATAL_ERRORS.has(name)) {
    return new NonRetryableError(
      `Bedrock rejected the request (${name}): ${message}. Verify the model id is enabled in this region and account.`,
      { code: name, cause: error },
    );
  }
  return new RetryableError(`Bedrock call failed: ${name}`, { code: name, cause: error });
};

export interface BedrockTextOptions {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export class BedrockClient {
  public constructor(
    private readonly client: BedrockRuntimeClient,
  ) {}

  public static forRegion(region: string): BedrockClient {
    return new BedrockClient(new BedrockRuntimeClient({ region }));
  }

  /**
   * Text generation via the Converse API, which normalises the request shape
   * across model families so swapping BEDROCK_TEXT_MODEL_ID does not require a
   * code change.
   */
  public async generateText(options: BedrockTextOptions): Promise<string> {
    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: options.modelId,
          system: [{ text: options.systemPrompt }],
          messages: [{ role: 'user', content: [{ text: options.userPrompt }] }],
          inferenceConfig: {
            maxTokens: options.maxTokens ?? 512,
            temperature: options.temperature ?? 0.9,
          },
        }),
      );
      const blocks: ContentBlock[] = response.output?.message?.content ?? [];
      const text = blocks
        .map((block) => ('text' in block ? block.text : undefined))
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
        .trim();
      if (!text) throw new RetryableError('Bedrock returned an empty text response');
      return text;
    } catch (error) {
      throw classifyBedrockError(error);
    }
  }

  /**
   * Image generation via InvokeModel. The request body differs per image model
   * family, so the caller supplies it; this method only handles transport,
   * error classification and response decoding.
   */
  public async invokeModel(modelId: string, body: unknown): Promise<unknown> {
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: new TextEncoder().encode(JSON.stringify(body)),
        }),
      );
      return JSON.parse(new TextDecoder().decode(response.body));
    } catch (error) {
      throw classifyBedrockError(error);
    }
  }
}

/**
 * LLMs wrap JSON in prose and code fences more often than they should. Extract
 * the first balanced JSON object rather than trusting the whole response.
 */
export const extractJsonObject = <T>(raw: string): T => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new RetryableError('Model response contained no JSON object', {
      context: { preview: candidate.slice(0, 200) },
    });
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch (error) {
    throw new RetryableError('Model response was not valid JSON', {
      cause: error,
      context: { preview: candidate.slice(0, 200) },
    });
  }
};
