import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { bedrock } from "@ai-sdk/amazon-bedrock";
import {
    generateObject as aiGenerateObject,
    generateText as aiGenerateText,
    type CoreTool,
    type GenerateObjectResult,
    type StepResult as AIStepResult,
    LanguageModelUsage,
} from "ai";
import { Buffer } from "buffer";
import { createOllama } from "ollama-ai-provider";
import OpenAI from "openai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
// import { AutoTokenizer } from "@huggingface/transformers";
import Together from "together-ai";
import type { ZodSchema } from "zod";
import { elizaLogger } from "./index.ts";
import {
    models,
    getModelSettings,
    getImageModelSettings,
    getEndpoint,
} from "./models.ts";
import {
    parseBooleanFromText,
    parseJsonArrayFromText,
    parseJSONObjectFromText,
    parseShouldRespondFromText,
    parseActionResponseFromText,
} from "./parsing.ts";
import settings from "./settings.ts";
import {
    type Content,
    type IAgentRuntime,
    type IImageDescriptionService,
    type ITextGenerationService,
    ModelClass,
    ModelProviderName,
    ServiceType,
    type ActionResponse,
    // type IVerifiableInferenceAdapter,
    // type VerifiableInferenceOptions,
    // type VerifiableInferenceResult,
    //VerifiableInferenceProvider,
    type TelemetrySettings,
    TokenizerType,
} from "./types.ts";
import { fal } from "@fal-ai/client";

import BigNumber from "bignumber.js";
import { createPublicClient, http } from "viem";
import fs from "fs";
import os from "os";
import path from "path";

type Tool = CoreTool<any, any>;
type StepResult = AIStepResult<any>;

// Simplify the types to avoid deep recursion
type GenerationResult = GenerateObjectResult<unknown>;

interface ProviderOptions {
    runtime: IAgentRuntime;
    provider: ModelProviderName;
    model: string;
    apiKey: string;
    schema?: ZodSchema;
    schemaName?: string;
    schemaDescription?: string;
    mode?: "auto" | "json" | "tool";
    modelOptions: ModelSettings;
    modelClass: ModelClass;
    context: string;
}

/**
 * Trims the provided text context to a specified token limit using a tokenizer model and type.
 *
 * The function dynamically determines the truncation method based on the tokenizer settings
 * provided by the runtime. If no tokenizer settings are defined, it defaults to using the
 * TikToken truncation method with the "gpt-4o" model.
 *
 * @async
 * @function trimTokens
 * @param {string} context - The text to be tokenized and trimmed.
 * @param {number} maxTokens - The maximum number of tokens allowed after truncation.
 * @param {IAgentRuntime} runtime - The runtime interface providing tokenizer settings.
 *
 * @returns {Promise<string>} A promise that resolves to the trimmed text.
 *
 * @throws {Error} Throws an error if the runtime settings are invalid or missing required fields.
 *
 * @example
 * const trimmedText = await trimTokens("This is an example text", 50, runtime);
 * console.log(trimmedText); // Output will be a truncated version of the input text.
 */
export async function trimTokens(
    context: string,
    maxTokens: number,
    runtime: IAgentRuntime
) {
    if (!context) return "";
    if (maxTokens <= 0) throw new Error("maxTokens must be positive");

    const tokenizerModel = runtime.getSetting("TOKENIZER_MODEL");
    const tokenizerType = runtime.getSetting("TOKENIZER_TYPE");

    if (!tokenizerModel || !tokenizerType) {
        // Default to TikToken truncation using the "gpt-4o" model if tokenizer settings are not defined
        return truncateTiktoken("gpt-4o", context, maxTokens);
    }

    // Choose the truncation method based on tokenizer type
    // if (tokenizerType === TokenizerType.Auto) {
    //     return truncateAuto(tokenizerModel, context, maxTokens);
    // }

    if (tokenizerType === TokenizerType.TikToken) {
        return truncateTiktoken(
            tokenizerModel as TiktokenModel,
            context,
            maxTokens
        );
    }

    elizaLogger.warn(`Unsupported tokenizer type: ${tokenizerType}`);
    return truncateTiktoken("gpt-4o", context, maxTokens);
}

// async function truncateAuto(
//     modelPath: string,
//     context: string,
//     maxTokens: number
// ) {
//     try {
//         const tokenizer = await AutoTokenizer.from_pretrained(modelPath);
//         const tokens = tokenizer.encode(context);

//         // If already within limits, return unchanged
//         if (tokens.length <= maxTokens) {
//             return context;
//         }

//         // Keep the most recent tokens by slicing from the end
//         const truncatedTokens = tokens.slice(-maxTokens);

//         // Decode back to text - js-tiktoken decode() returns a string directly
//         return tokenizer.decode(truncatedTokens);
//     } catch (error) {
//         elizaLogger.error("Error in trimTokens:", error);
//         // Return truncated string if tokenization fails
//         return context.slice(-maxTokens * 4); // Rough estimate of 4 chars per token
//     }
// }

async function truncateTiktoken(
    model: TiktokenModel,
    context: string,
    maxTokens: number
) {
    try {
        const encoding = encodingForModel(model);

        // Encode the text into tokens
        const tokens = encoding.encode(context);

        // If already within limits, return unchanged
        if (tokens.length <= maxTokens) {
            return context;
        }

        // Keep the most recent tokens by slicing from the end
        const truncatedTokens = tokens.slice(-maxTokens);

        // Decode back to text - js-tiktoken decode() returns a string directly
        return encoding.decode(truncatedTokens);
    } catch (error) {
        elizaLogger.error("Error in trimTokens:", error);
        // Return truncated string if tokenization fails
        return context.slice(-maxTokens * 4); // Rough estimate of 4 chars per token
    }
}

/**
 * Get OnChain EternalAI System Prompt
 * @returns System Prompt
 */
async function getOnChainEternalAISystemPrompt(
    runtime: IAgentRuntime
): Promise<string> | undefined {
    const agentId = runtime.getSetting("ETERNALAI_AGENT_ID");
    const providerUrl = runtime.getSetting("ETERNALAI_RPC_URL");
    const contractAddress = runtime.getSetting(
        "ETERNALAI_AGENT_CONTRACT_ADDRESS"
    );
    if (agentId && providerUrl && contractAddress) {
        // get on-chain system-prompt
        const contractABI = [
            {
                inputs: [
                    {
                        internalType: "uint256",
                        name: "_agentId",
                        type: "uint256",
                    },
                ],
                name: "getAgentSystemPrompt",
                outputs: [
                    { internalType: "bytes[]", name: "", type: "bytes[]" },
                ],
                stateMutability: "view",
                type: "function",
            },
        ];

        const publicClient = createPublicClient({
            transport: http(providerUrl),
        });

        try {
            const validAddress: `0x${string}` =
                contractAddress as `0x${string}`;
            const result = await publicClient.readContract({
                address: validAddress,
                abi: contractABI,
                functionName: "getAgentSystemPrompt",
                args: [new BigNumber(agentId)],
            });
            if (result) {
                elizaLogger.info("on-chain system-prompt response", result[0]);
                const value = result[0].toString().replace("0x", "");
                const content = Buffer.from(value, "hex").toString("utf-8");
                elizaLogger.info("on-chain system-prompt", content);
                return await fetchEternalAISystemPrompt(runtime, content);
            } else {
                return undefined;
            }
        } catch (error) {
            elizaLogger.error(error);
            elizaLogger.error("err", error);
        }
    }
    return undefined;
}

/**
 * Fetch EternalAI System Prompt
 * @returns System Prompt
 */
async function fetchEternalAISystemPrompt(
    runtime: IAgentRuntime,
    content: string
): Promise<string> | undefined {
    const IPFS = "ipfs://";
    const containsSubstring: boolean = content.includes(IPFS);
    if (containsSubstring) {
        const lightHouse = content.replace(
            IPFS,
            "https://gateway.lighthouse.storage/ipfs/"
        );
        elizaLogger.info("fetch lightHouse", lightHouse);
        const responseLH = await fetch(lightHouse, {
            method: "GET",
        });
        elizaLogger.info("fetch lightHouse resp", responseLH);
        if (responseLH.ok) {
            const data = await responseLH.text();
            return data;
        } else {
            const gcs = content.replace(
                IPFS,
                "https://cdn.eternalai.org/upload/"
            );
            elizaLogger.info("fetch gcs", gcs);
            const responseGCS = await fetch(gcs, {
                method: "GET",
            });
            elizaLogger.info("fetch lightHouse gcs", responseGCS);
            if (responseGCS.ok) {
                const data = await responseGCS.text();
                return data;
            } else {
                throw new Error("invalid on-chain system prompt");
            }
        }
    } else {
        return content;
    }
}

/**
 * Gets the Cloudflare Gateway base URL for a specific provider if enabled
 * @param runtime The runtime environment
 * @param provider The model provider name
 * @returns The Cloudflare Gateway base URL if enabled, undefined otherwise
 */
function getCloudflareGatewayBaseURL(
    runtime: IAgentRuntime,
    provider: string
): string | undefined {
    const isCloudflareEnabled =
        runtime.getSetting("CLOUDFLARE_GW_ENABLED") === "true";
    const cloudflareAccountId = runtime.getSetting("CLOUDFLARE_AI_ACCOUNT_ID");
    const cloudflareGatewayId = runtime.getSetting("CLOUDFLARE_AI_GATEWAY_ID");

    elizaLogger.debug("Cloudflare Gateway Configuration:", {
        isEnabled: isCloudflareEnabled,
        hasAccountId: !!cloudflareAccountId,
        hasGatewayId: !!cloudflareGatewayId,
        provider: provider,
    });

    if (!isCloudflareEnabled) {
        elizaLogger.debug("Cloudflare Gateway is not enabled");
        return undefined;
    }

    if (!cloudflareAccountId) {
        elizaLogger.warn(
            "Cloudflare Gateway is enabled but CLOUDFLARE_AI_ACCOUNT_ID is not set"
        );
        return undefined;
    }

    if (!cloudflareGatewayId) {
        elizaLogger.warn(
            "Cloudflare Gateway is enabled but CLOUDFLARE_AI_GATEWAY_ID is not set"
        );
        return undefined;
    }

    const baseURL = `https://gateway.ai.cloudflare.com/v1/${cloudflareAccountId}/${cloudflareGatewayId}/${provider.toLowerCase()}`;
    elizaLogger.info("Using Cloudflare Gateway:", {
        provider,
        baseURL,
        accountId: cloudflareAccountId,
        gatewayId: cloudflareGatewayId,
    });

    return baseURL;
}

const getToken = (runtime, modelProvider: ModelProviderName) => {
    // First try to match the specific provider
    switch (modelProvider) {
        case ModelProviderName.HEURIST:
            return runtime.getSetting("HEURIST_API_KEY");
        case ModelProviderName.TOGETHER:
            return runtime.getSetting("TOGETHER_API_KEY");
        case ModelProviderName.FAL:
            return runtime.getSetting("FAL_API_KEY");
        case ModelProviderName.OPENAI:
            return runtime.getSetting("OPENAI_API_KEY");
        case ModelProviderName.VENICE:
            return runtime.getSetting("VENICE_API_KEY");
        case ModelProviderName.LIVEPEER:
            return runtime.getSetting("LIVEPEER_GATEWAY_URL");
        case ModelProviderName.TITLES:
            return runtime.getSetting("TITLES_API_KEY");
        default:
            // If no specific match, try the fallback chain
            return (
                runtime.getSetting("HEURIST_API_KEY") ??
                runtime.getSetting("NINETEEN_AI_API_KEY") ??
                runtime.getSetting("TOGETHER_API_KEY") ??
                runtime.getSetting("FAL_API_KEY") ??
                runtime.getSetting("OPENAI_API_KEY") ??
                runtime.getSetting("VENICE_API_KEY") ??
                runtime.getSetting("LIVEPEER_GATEWAY_URL")
            );
    }
};

/**
 * Send a message to the model for a text generateText - receive a string back and parse how you'd like
 * @param opts - The options for the generateText request.
 * @param opts.context The context of the message to be completed.
 * @param opts.stop A list of strings to stop the generateText at.
 * @param opts.model The model to use for generateText.
 * @param opts.frequency_penalty The frequency penalty to apply to the generateText.
 * @param opts.presence_penalty The presence penalty to apply to the generateText.
 * @param opts.temperature The temperature to apply to the generateText.
 * @param opts.max_context_length The maximum length of the context to apply to the generateText.
 * @returns The completed message.
 */

export async function generateText({
    runtime,
    context,
    modelClass,
    modelProvider,
    tools = {},
    onStepFinish,
    maxSteps = 1,
    stop,
    customSystemPrompt,
    returnUsage = false,
    messages,
}: // verifiableInference = process.env.VERIFIABLE_INFERENCE_ENABLED === "true",
// verifiableInferenceOptions,
{
    runtime: IAgentRuntime;
    context?: string;
    modelClass: ModelClass;
    modelProvider?: ModelProviderName;
    tools?: Record<string, Tool>;
    onStepFinish?: (event: StepResult) => Promise<void> | void;
    maxSteps?: number;
    stop?: string[];
    customSystemPrompt?: string;
    // verifiableInference?: boolean;
    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;
    // verifiableInferenceOptions?: VerifiableInferenceOptions;
    returnUsage?: boolean;
    messages?: any[]
}): Promise<string | { response: string; usage: LanguageModelUsage; }> {
    if (!context && messages.length === 0) {
        console.error("generateText context is empty");
        return "";
    }

    elizaLogger.info("Arrived at generateText");

    elizaLogger.info("Generating text...");

    // elizaLogger.info("Generating text with options:", {
    //     modelProvider: modelProvider || runtime.modelProvider,
    //     model: modelClass,
    //     // verifiableInference,
    // });
    // If verifiable inference is requested and adapter is provided, use it
    // if (verifiableInference && runtime.verifiableInferenceAdapter) {
    //     elizaLogger.log(
    //         "Using verifiable inference adapter:",
    //         runtime.verifiableInferenceAdapter
    //     );
    //     try {
    //         const result: VerifiableInferenceResult =
    //             await runtime.verifiableInferenceAdapter.generateText(
    //                 context,
    //                 modelClass,
    //                 verifiableInferenceOptions
    //             );
    //         elizaLogger.log("Verifiable inference result:", result);
    //         // Verify the proof
    //         const isValid =
    //             await runtime.verifiableInferenceAdapter.verifyProof(result);
    //         if (!isValid) {
    //             throw new Error("Failed to verify inference proof");
    //         }

    //         return result.text;
    //     } catch (error) {
    //         elizaLogger.error("Error in verifiable inference:", error);
    //         throw error;
    //     }
    // }

    const provider = modelProvider || runtime.modelProvider;
    elizaLogger.info("Arrived at modelProvider", modelProvider);
    // elizaLogger.info("Provider settings:", {
    //     provider,
    //     hasRuntime: !!runtime,
    //     runtimeSettings: {
    //         CLOUDFLARE_GW_ENABLED: runtime.getSetting("CLOUDFLARE_GW_ENABLED"),
    //         CLOUDFLARE_AI_ACCOUNT_ID: runtime.getSetting(
    //             "CLOUDFLARE_AI_ACCOUNT_ID"
    //         ),
    //         CLOUDFLARE_AI_GATEWAY_ID: runtime.getSetting(
    //             "CLOUDFLARE_AI_GATEWAY_ID"
    //         ),
    //     },
    // });

    // elizaLogger.info("Arrived at runtime.character.modelEndpointOverride", runtime.character.modelEndpointOverride);
    elizaLogger.info("Arrived at runtime.character", runtime);
    elizaLogger.info("Arrived at getEndpoint", getEndpoint(provider));

    const endpoint =
        runtime?.character?.modelEndpointOverride || getEndpoint(provider);
    elizaLogger.info("Arrived at endpoint", endpoint);
    const modelSettings = getModelSettings(provider, modelClass);
    elizaLogger.info("Arrived at modelSettings", modelSettings);
    let model = modelSettings.name;
    elizaLogger.info("Arrived at model", model);

    // allow character.json settings => secrets to override models
    // FIXME: add MODEL_MEDIUM support
    // switch (provider) {
    //     // if runtime.getSetting("LLAMACLOUD_MODEL_LARGE") is true and modelProvider is LLAMACLOUD, then use the large model
    //     case ModelProviderName.LLAMACLOUD:
    //         {
    //             switch (modelClass) {
    //                 case ModelClass.LARGE:
    //                     {
    //                         model =
    //                             runtime.getSetting("LLAMACLOUD_MODEL_LARGE") ||
    //                             model;
    //                     }
    //                     break;
    //                 case ModelClass.SMALL:
    //                     {
    //                         model =
    //                             runtime.getSetting("LLAMACLOUD_MODEL_SMALL") ||
    //                             model;
    //                     }
    //                     break;
    //             }
    //         }
    //         break;
    //     case ModelProviderName.TOGETHER:
    //         {
    //             switch (modelClass) {
    //                 case ModelClass.LARGE:
    //                     {
    //                         model =
    //                             runtime.getSetting("TOGETHER_MODEL_LARGE") ||
    //                             model;
    //                     }
    //                     break;
    //                 case ModelClass.SMALL:
    //                     {
    //                         model =
    //                             runtime.getSetting("TOGETHER_MODEL_SMALL") ||
    //                             model;
    //                     }
    //                     break;
    //             }
    //         }
    //         break;
    //     case ModelProviderName.OPENROUTER:
    //         {
    //             switch (modelClass) {
    //                 case ModelClass.LARGE:
    //                     {
    //                         model =
    //                             runtime.getSetting("LARGE_OPENROUTER_MODEL") ||
    //                             model;
    //                     }
    //                     break;
    //                 case ModelClass.SMALL:
    //                     {
    //                         model =
    //                             runtime.getSetting("SMALL_OPENROUTER_MODEL") ||
    //                             model;
    //                     }
    //                     break;
    //             }
    //         }
    //         break;
    // }

    elizaLogger.info("Selected model:", model);

    const modelConfiguration = runtime.character?.settings?.modelConfig;
    const temperature =
        modelConfiguration?.temperature || modelSettings.temperature;
    const frequency_penalty =
        modelConfiguration?.frequency_penalty ||
        modelSettings.frequency_penalty;
    const presence_penalty =
        modelConfiguration?.presence_penalty || modelSettings.presence_penalty;
    const max_context_length =
        modelConfiguration?.maxInputTokens || modelSettings.maxInputTokens;
    const max_response_length =
        modelConfiguration?.maxOutputTokens || modelSettings.maxOutputTokens;
    const experimental_telemetry =
        modelConfiguration?.experimental_telemetry ||
        modelSettings.experimental_telemetry;

    const apiKey = modelProvider
        ? getToken(runtime, modelProvider)
        : runtime.token;

    try {
        elizaLogger.debug(
            `Trimming context to max length of ${max_context_length} tokens.`
        );

        context = await trimTokens(context, max_context_length, runtime);

        let response: string;
        let usage: LanguageModelUsage;

        const _stop = stop || modelSettings.stop;
        elizaLogger.debug(
            `Using provider: ${provider}, model: ${model}, temperature: ${temperature}, max response length: ${max_response_length}`
        );

        switch (provider) {
            // OPENAI & LLAMACLOUD shared same structure.
            case ModelProviderName.OPENAI:
            case ModelProviderName.ALI_BAILIAN:
            case ModelProviderName.VOLENGINE:
            case ModelProviderName.LLAMACLOUD:
            case ModelProviderName.NANOGPT:
            case ModelProviderName.HYPERBOLIC:
            case ModelProviderName.TOGETHER:
            case ModelProviderName.NINETEEN_AI:
            case ModelProviderName.AKASH_CHAT_API:
            case ModelProviderName.LMSTUDIO:
            case ModelProviderName.NEARAI: {
                elizaLogger.debug(
                    "Initializing OpenAI model with Cloudflare check"
                );
                const baseURL =
                    getCloudflareGatewayBaseURL(runtime, "openai") || endpoint;

                //elizaLogger.debug("OpenAI baseURL result:", { baseURL });
                const openai = createOpenAI({
                    apiKey,
                    baseURL,
                    fetch: runtime.fetch,
                });

                const { text: openaiResponse, usage: openaiUsage } = await aiGenerateText({
                    model: tools && Object.keys(tools).length > 0 ? openai.responses(model) : openai.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = openaiResponse;
                usage = openaiUsage;
                console.log("Received response from OpenAI model.");
                break;
            }

            case ModelProviderName.ETERNALAI: {
                elizaLogger.debug("Initializing EternalAI model.");
                const openai = createOpenAI({
                    apiKey,
                    baseURL: endpoint,
                    fetch: async (
                        input: RequestInfo | URL,
                        init?: RequestInit
                    ): Promise<Response> => {
                        const url =
                            typeof input === "string"
                                ? input
                                : input.toString();
                        const chain_id =
                            runtime.getSetting("ETERNALAI_CHAIN_ID") || "45762";

                        const options: RequestInit = { ...init };
                        if (options?.body) {
                            const body = JSON.parse(options.body as string);
                            body.chain_id = chain_id;
                            options.body = JSON.stringify(body);
                        }

                        const fetching = await runtime.fetch(url, options);

                        if (
                            parseBooleanFromText(
                                runtime.getSetting("ETERNALAI_LOG")
                            )
                        ) {
                            elizaLogger.info(
                                "Request data: ",
                                JSON.stringify(options, null, 2)
                            );
                            const clonedResponse = fetching.clone();
                            try {
                                clonedResponse.json().then((data) => {
                                    elizaLogger.info(
                                        "Response data: ",
                                        JSON.stringify(data, null, 2)
                                    );
                                });
                            } catch (e) {
                                elizaLogger.debug(e);
                            }
                        }
                        return fetching;
                    },
                });

                let system_prompt =
                    runtime.character.system ??
                    settings.SYSTEM_PROMPT ??
                    undefined;
                try {
                    const on_chain_system_prompt =
                        await getOnChainEternalAISystemPrompt(runtime);
                    if (!on_chain_system_prompt) {
                        elizaLogger.error(
                            new Error("invalid on_chain_system_prompt")
                        );
                    } else {
                        system_prompt = on_chain_system_prompt;
                        elizaLogger.info(
                            "new on-chain system prompt",
                            system_prompt
                        );
                    }
                } catch (e) {
                    elizaLogger.error(e);
                }

                const { text: openaiResponse } = await aiGenerateText({
                    model: openai.languageModel(model),
                    prompt: context,
                    system: system_prompt,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                });

                response = openaiResponse;
                elizaLogger.debug("Received response from EternalAI model.");
                break;
            }

            case ModelProviderName.GOOGLE: {
                const google = createGoogleGenerativeAI({
                    apiKey,
                    fetch: runtime.fetch,
                });

                const { text: googleResponse, usage: googleUsage } = await aiGenerateText({
                    model: google(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = googleResponse;
                usage = googleUsage;
                elizaLogger.debug("Received response from Google model.");
                break;
            }

            case ModelProviderName.MISTRAL: {
                const mistral = createMistral();

                const { text: mistralResponse, usage: mistralUsage } = await aiGenerateText({
                    model: mistral(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                });

                response = mistralResponse;
                usage = mistralUsage;
                elizaLogger.debug("Received response from Mistral model.");
                break;
            }

            case ModelProviderName.ANTHROPIC: {
                elizaLogger.debug(
                    "Initializing Anthropic model with Cloudflare check"
                );
                const baseURL =
                    getCloudflareGatewayBaseURL(runtime, "anthropic") ||
                    "https://api.anthropic.com/v1";
                elizaLogger.debug("Anthropic baseURL result:", { baseURL });

                const anthropic = createAnthropic({
                    apiKey,
                    baseURL,
                    fetch: runtime.fetch,
                });
                const { text: anthropicResponse, usage: anthropicUsage } = await aiGenerateText({
                    model: anthropic.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = anthropicResponse;
                usage = anthropicUsage;
                elizaLogger.debug("Received response from Anthropic model.");
                break;
            }

            case ModelProviderName.CLAUDE_VERTEX: {
                elizaLogger.debug("Initializing Claude Vertex model.");

                const anthropic = createAnthropic({
                    apiKey,
                    fetch: runtime.fetch,
                });

                const { text: anthropicResponse, usage: anthropicUsage } = await aiGenerateText({
                    model: anthropic.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = anthropicResponse;
                usage = anthropicUsage;
                elizaLogger.debug(
                    "Received response from Claude Vertex model."
                );
                break;
            }

            case ModelProviderName.GROK: {
                elizaLogger.debug("Initializing Grok model.");
                const grok = createOpenAI({
                    apiKey,
                    baseURL: endpoint,
                    fetch: runtime.fetch,
                });

                const { text: grokResponse, usage: grokUsage } = await aiGenerateText({
                    model: grok.languageModel(model, {
                        parallelToolCalls: false,
                    }),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = grokResponse;
                usage = grokUsage;
                elizaLogger.debug("Received response from Grok model.");
                break;
            }

            case ModelProviderName.GROQ: {
                elizaLogger.debug(
                    "Initializing Groq model with Cloudflare check"
                );
                const baseURL = getCloudflareGatewayBaseURL(runtime, "groq");
                elizaLogger.debug("Groq baseURL result:", { baseURL });
                const groq = createGroq({
                    apiKey,
                    fetch: runtime.fetch,
                    baseURL,
                });

                const { text: groqResponse, usage: groqUsage } = await aiGenerateText({
                    model: groq.languageModel(model),
                    prompt: context,
                    temperature,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools,
                    onStepFinish: onStepFinish,
                    maxSteps,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry,
                });

                response = groqResponse;
                usage = groqUsage;
                elizaLogger.debug("Received response from Groq model.");
                break;
            }

            case ModelProviderName.LLAMALOCAL: {
                elizaLogger.debug(
                    "Using local Llama model for text completion."
                );
                const textGenerationService =
                    runtime.getService<ITextGenerationService>(
                        ServiceType.TEXT_GENERATION
                    );

                if (!textGenerationService) {
                    throw new Error("Text generation service not found");
                }

                response = await textGenerationService.queueTextCompletion(
                    context,
                    temperature,
                    _stop,
                    frequency_penalty,
                    presence_penalty,
                    max_response_length
                );
                elizaLogger.debug("Received response from local Llama model.");
                break;
            }

            case ModelProviderName.REDPILL: {
                elizaLogger.debug("Initializing RedPill model.");
                const serverUrl = getEndpoint(provider);
                const openai = createOpenAI({
                    apiKey,
                    baseURL: serverUrl,
                    fetch: runtime.fetch,
                });

                const { text: redpillResponse, usage: redpillUsage } = await aiGenerateText({
                    model: openai.languageModel(model),
                    prompt: context,
                    temperature: temperature,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = redpillResponse;
                usage = redpillUsage;
                elizaLogger.debug("Received response from redpill model.");
                break;
            }

            case ModelProviderName.OPENROUTER: {
                elizaLogger.debug("Initializing OpenRouter model.");
                const serverUrl = getEndpoint(provider);
                const openrouter = createOpenAI({
                    apiKey,
                    baseURL: serverUrl,
                    fetch: runtime.fetch,
                });

                const { text: openrouterResponse, usage: openrouterUsage } = await aiGenerateText({
                    model: openrouter.languageModel(model),
                    prompt: context,
                    temperature: temperature,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = openrouterResponse;
                usage = openrouterUsage;
                elizaLogger.debug("Received response from OpenRouter model.");
                break;
            }

            case ModelProviderName.OLLAMA:
                {
                    elizaLogger.debug("Initializing Ollama model.");

                    const ollamaProvider = createOllama({
                        baseURL: getEndpoint(provider) + "/api",
                        fetch: runtime.fetch,
                    });
                    const ollama = ollamaProvider(model);

                    elizaLogger.debug("****** MODEL\n", model);

                    const { text: ollamaResponse, usage: ollamaUsage } = await aiGenerateText({
                        model: ollama,
                        prompt: context,
                        tools: tools,
                        onStepFinish: onStepFinish,
                        temperature: temperature,
                        maxSteps: maxSteps,
                        maxTokens: max_response_length,
                        frequencyPenalty: frequency_penalty,
                        presencePenalty: presence_penalty,
                        experimental_telemetry: experimental_telemetry,
                    });

                    response = ollamaResponse.replace(
                        /<think>[\s\S]*?<\/think>\s*\n*/g,
                        ""
                    );
                    usage = ollamaUsage;
                }
                elizaLogger.debug("Received response from Ollama model.");
                break;

            case ModelProviderName.HEURIST: {
                elizaLogger.debug("Initializing Heurist model.");
                const heurist = createOpenAI({
                    apiKey: apiKey,
                    baseURL: endpoint,
                    fetch: runtime.fetch,
                });

                const { text: heuristResponse, usage: heuristUsage } = await aiGenerateText({
                    model: heurist.languageModel(model),
                    prompt: context,
                    system:
                        customSystemPrompt ??
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    maxSteps: maxSteps,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = heuristResponse;
                usage = heuristUsage;
                elizaLogger.debug("Received response from Heurist model.");
                break;
            }
            case ModelProviderName.GAIANET: {
                elizaLogger.debug("Initializing GAIANET model.");

                var baseURL = getEndpoint(provider);
                if (!baseURL) {
                    switch (modelClass) {
                        case ModelClass.SMALL:
                            baseURL =
                                settings.SMALL_GAIANET_SERVER_URL ||
                                "https://llama3b.gaia.domains/v1";
                            break;
                        case ModelClass.MEDIUM:
                            baseURL =
                                settings.MEDIUM_GAIANET_SERVER_URL ||
                                "https://llama8b.gaia.domains/v1";
                            break;
                        case ModelClass.LARGE:
                            baseURL =
                                settings.LARGE_GAIANET_SERVER_URL ||
                                "https://qwen72b.gaia.domains/v1";
                            break;
                    }
                }

                elizaLogger.debug("Using GAIANET model with baseURL:", baseURL);

                const openai = createOpenAI({
                    apiKey,
                    baseURL: endpoint,
                    fetch: runtime.fetch,
                });

                const { text: openaiResponse, usage: openaiUsage } = await aiGenerateText({
                    model: openai.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = openaiResponse;
                usage = openaiUsage;
                elizaLogger.debug("Received response from GAIANET model.");
                break;
            }

            case ModelProviderName.ATOMA: {
                elizaLogger.debug("Initializing Atoma model.");
                const atoma = createOpenAI({
                    apiKey,
                    baseURL: endpoint,
                    fetch: runtime.fetch,
                });

                const { text: atomaResponse, usage: atomaUsage } = await aiGenerateText({
                    model: atoma.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = atomaResponse;
                usage = atomaUsage;
                elizaLogger.debug("Received response from Atoma model.");
                break;
            }

            case ModelProviderName.GALADRIEL: {
                elizaLogger.debug("Initializing Galadriel model.");
                const headers = {};
                const fineTuneApiKey = runtime.getSetting(
                    "GALADRIEL_FINE_TUNE_API_KEY"
                );
                if (fineTuneApiKey) {
                    headers["Fine-Tune-Authentication"] = fineTuneApiKey;
                }
                const galadriel = createOpenAI({
                    headers,
                    apiKey: apiKey,
                    baseURL: endpoint,
                    fetch: runtime.fetch,
                });

                const { text: galadrielResponse, usage: galadrielUsage } = await aiGenerateText({
                    model: galadriel.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = galadrielResponse;
                usage = galadrielUsage;
                elizaLogger.debug("Received response from Galadriel model.");
                break;
            }

            case ModelProviderName.INFERA: {
                elizaLogger.debug("Initializing Infera model.");

                const apiKey = settings.INFERA_API_KEY || runtime.token;

                const infera = createOpenAI({
                    apiKey,
                    baseURL: endpoint,
                    headers: {
                        api_key: apiKey,
                        "Content-Type": "application/json",
                    },
                });

                const { text: inferaResponse, usage: inferaUsage } = await aiGenerateText({
                    model: infera.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                });
                response = inferaResponse;
                usage = inferaUsage;
                elizaLogger.debug("Received response from Infera model.");
                break;
            }

            case ModelProviderName.VENICE: {
                elizaLogger.debug("Initializing Venice model.");
                const venice = createOpenAI({
                    apiKey: apiKey,
                    baseURL: endpoint,
                });

                elizaLogger.log(`model: ${model}`);
                const { text: veniceResponse, usage: veniceUsage } = await aiGenerateText({
                    model: venice.languageModel(model),
                    prompt: messages?.length ? undefined : context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    temperature: temperature,
                    maxSteps: maxSteps,
                    maxTokens: max_response_length,
                    messages: messages
                });

                // console.warn("veniceResponse:")
                // console.warn(veniceResponse)
                //rferrari: remove all text from <think> to </think>\n\n
                response = veniceResponse.replace(
                    /<think>[\s\S]*?<\/think>\s*\n*/g,
                    ""
                );
                // console.warn(response)
                usage = veniceUsage;

                // response = veniceResponse;
                elizaLogger.debug("Received response from Venice model.");
                break;
            }

            case ModelProviderName.NVIDIA: {
                elizaLogger.debug("Initializing NVIDIA model.");
                const nvidia = createOpenAI({
                    apiKey: apiKey,
                    baseURL: endpoint,
                });

                const { text: nvidiaResponse, usage: nvidiaUsage } = await aiGenerateText({
                    model: nvidia.languageModel(model),
                    prompt: context,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    temperature: temperature,
                    maxSteps: maxSteps,
                    maxTokens: max_response_length,
                });

                response = nvidiaResponse;
                usage = nvidiaUsage;
                elizaLogger.debug("Received response from NVIDIA model.");
                break;
            }

            case ModelProviderName.DEEPSEEK: {
                elizaLogger.debug("Initializing Deepseek model.");
                const serverUrl = models[provider].endpoint;
                const deepseek = createOpenAI({
                    apiKey,
                    baseURL: serverUrl,
                    fetch: runtime.fetch,
                });

                const { text: deepseekResponse, usage: deepseekUsage } = await aiGenerateText({
                    model: deepseek.languageModel(model),
                    prompt: context,
                    temperature: temperature,
                    system:
                        runtime.character.system ??
                        settings.SYSTEM_PROMPT ??
                        undefined,
                    tools: tools,
                    onStepFinish: onStepFinish,
                    maxSteps: maxSteps,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                });

                response = deepseekResponse;
                usage = deepseekUsage;
                elizaLogger.debug("Received response from Deepseek model.");
                break;
            }

            case ModelProviderName.LIVEPEER: {
                elizaLogger.debug("Initializing Livepeer model.");

                if (!endpoint) {
                    throw new Error("Livepeer Gateway URL is not defined");
                }

                const requestBody = {
                    model: model,
                    messages: [
                        {
                            role: "system",
                            content:
                                runtime.character.system ??
                                settings.SYSTEM_PROMPT ??
                                "You are a helpful assistant",
                        },
                        {
                            role: "user",
                            content: context,
                        },
                    ],
                    max_tokens: max_response_length,
                    stream: false,
                };

                const fetchResponse = await runtime.fetch(endpoint + "/llm", {
                    method: "POST",
                    headers: {
                        accept: "text/event-stream",
                        "Content-Type": "application/json",
                        Authorization: "Bearer eliza-app-llm",
                    },
                    body: JSON.stringify(requestBody),
                });

                if (!fetchResponse.ok) {
                    const errorText = await fetchResponse.text();
                    throw new Error(
                        `Livepeer request failed (${fetchResponse.status}): ${errorText}`
                    );
                }

                const json = await fetchResponse.json();

                if (!json?.choices?.[0]?.message?.content) {
                    throw new Error("Invalid response format from Livepeer");
                }

                response = json.choices[0].message.content.replace(
                    /<\|start_header_id\|>assistant<\|end_header_id\|>\n\n/,
                    ""
                );
                usage = {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                };
                elizaLogger.debug(
                    "Successfully received response from Livepeer model"
                );
                break;
            }

            case ModelProviderName.SECRETAI:
                {
                    elizaLogger.debug("Initializing SecretAI model.");

                    const secretAiProvider = createOllama({
                        baseURL: getEndpoint(provider) + "/api",
                        fetch: runtime.fetch,
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${apiKey}`,
                        },
                    });
                    const secretAi = secretAiProvider(model);

                    const { text: secretAiResponse, usage: secretUsage } = await aiGenerateText({
                        model: secretAi,
                        prompt: context,
                        tools: tools,
                        onStepFinish: onStepFinish,
                        temperature: temperature,
                        maxSteps: maxSteps,
                        maxTokens: max_response_length,
                    });

                    response = secretAiResponse;
                    usage = secretUsage;
                }
                break;

            case ModelProviderName.BEDROCK: {
                elizaLogger.debug("Initializing Bedrock model.");

                const { text: bedrockResponse, usage: bedrockUsage } = await aiGenerateText({
                    model: bedrock(model),
                    maxSteps: maxSteps,
                    temperature: temperature,
                    maxTokens: max_response_length,
                    frequencyPenalty: frequency_penalty,
                    presencePenalty: presence_penalty,
                    experimental_telemetry: experimental_telemetry,
                    prompt: context,
                });

                response = bedrockResponse;
                usage = bedrockUsage;
                elizaLogger.debug("Received response from Bedrock model.");
                break;
            }

            default: {
                const errorMessage = `Unsupported provider: ${provider}`;
                elizaLogger.error(errorMessage);
                throw new Error(errorMessage);
            }
        }

        return returnUsage ? { response, usage } : response;
    } catch (error) {
        elizaLogger.error("Error in generateText:", error);
        throw error;
    }
}

/**
 * Sends a message to the model to determine if it should respond to the given context.
 * @param opts - The options for the generateText request
 * @param opts.context The context to evaluate for response
 * @param opts.stop A list of strings to stop the generateText at
 * @param opts.model The model to use for generateText
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to "RESPOND", "IGNORE", "STOP" or null
 */
export async function generateShouldRespond({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            elizaLogger.debug(
                "Attempting to generate text with context:",
                context
            );
            const response = await generateText({
                runtime,
                context,
                modelClass,
            }) as string;

            elizaLogger.debug("Received response from generateText:", response);
            const parsedResponse = parseShouldRespondFromText(response.trim());
            if (parsedResponse) {
                elizaLogger.debug("Parsed response:", parsedResponse);
                return parsedResponse;
            } else {
                elizaLogger.debug("generateShouldRespond no response");
            }
        } catch (error) {
            elizaLogger.error("Error in generateShouldRespond:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }

        elizaLogger.log(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Splits content into chunks of specified size with optional overlapping bleed sections
 * @param content - The text content to split into chunks
 * @param chunkSize - The maximum size of each chunk in tokens
 * @param bleed - Number of characters to overlap between chunks (default: 100)
 * @returns Promise resolving to array of text chunks with bleed sections
 */
export async function splitChunks(
    content: string,
    chunkSize = 1500,
    bleed = 100
): Promise<string[]> {
    elizaLogger.debug(`[splitChunks] Starting text split`);

    // Validate parameters
    if (chunkSize <= 0) {
        elizaLogger.warn(
            `Invalid chunkSize (${chunkSize}), using default 1500`
        );
        chunkSize = 1500;
    }

    if (bleed >= chunkSize) {
        elizaLogger.warn(
            `Bleed (${bleed}) >= chunkSize (${chunkSize}), adjusting bleed to 1/4 of chunkSize`
        );
        bleed = Math.floor(chunkSize / 4);
    }

    if (bleed < 0) {
        elizaLogger.warn(`Invalid bleed (${bleed}), using default 100`);
        bleed = 100;
    }

    const chunks = splitText(content, chunkSize, bleed);

    elizaLogger.debug(`[splitChunks] Split complete:`, {
        numberOfChunks: chunks.length,
        averageChunkSize:
            chunks.reduce((acc, chunk) => acc + chunk.length, 0) /
            chunks.length,
    });

    return chunks;
}

export function splitText(
    content: string,
    chunkSize: number,
    bleed: number
): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
        const end = Math.min(start + chunkSize, content.length);
        // Ensure we're not creating empty or invalid chunks
        if (end > start) {
            chunks.push(content.substring(start, end));
        }

        // Ensure forward progress while preventing infinite loops
        start = Math.max(end - bleed, start + 1);
    }

    return chunks;
}

/**
 * Sends a message to the model and parses the response as a boolean value
 * @param opts - The options for the generateText request
 * @param opts.context The context to evaluate for the boolean response
 * @param opts.stop A list of strings to stop the generateText at
 * @param opts.model The model to use for generateText
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to a boolean value parsed from the model's response
 */
export async function generateTrueOrFalse({
    runtime,
    context = "",
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<boolean> {
    let retryDelay = 1000;
    const modelSettings = getModelSettings(runtime.modelProvider, modelClass);
    const stop = Array.from(
        new Set([...(modelSettings.stop || []), ["\n"]])
    ) as string[];

    while (true) {
        try {
            const response = await generateText({
                stop,
                runtime,
                context,
                modelClass,
            }) as string;

            const parsedResponse = parseBooleanFromText(response.trim());
            if (parsedResponse !== null) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTrueOrFalse:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Send a message to the model and parse the response as a string array
 * @param opts - The options for the generateText request
 * @param opts.context The context/prompt to send to the model
 * @param opts.stop Array of strings that will stop the model's generation if encountered
 * @param opts.model The language model to use
 * @param opts.frequency_penalty The frequency penalty to apply (0.0 to 2.0)
 * @param opts.presence_penalty The presence penalty to apply (0.0 to 2.0)
 * @param opts.temperature The temperature to control randomness (0.0 to 2.0)
 * @param opts.serverUrl The URL of the API server
 * @param opts.token The API token for authentication
 * @param opts.max_context_length Maximum allowed context length in tokens
 * @param opts.max_response_length Maximum allowed response length in tokens
 * @returns Promise resolving to an array of strings parsed from the model's response
 */
export async function generateTextArray({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<string[]> {
    if (!context) {
        elizaLogger.error("generateTextArray context is empty");
        return [];
    }
    let retryDelay = 1000;

    while (true) {
        try {
            const response = await generateText({
                runtime,
                context,
                modelClass,
            });

            const parsedResponse = parseJsonArrayFromText(response as string);
            if (parsedResponse) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTextArray:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

export async function generateObjectDeprecated({
    runtime,
    context,
    modelClass,
    modelProvider,
    returnUsage = false,
    tools = {},
    messages,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    modelProvider?: ModelProviderName;
    returnUsage?: boolean;
    tools?: Record<string, Tool>;
    messages?: any
}): Promise<any> {
    elizaLogger.info("Arrived at generateObjectDeprecated", messages);
    if (!context && messages.length === 0) {
        elizaLogger.error("generateObjectDeprecated context and messages is empty");
        return null;
    }
    let retryDelay = 1000;

    while (true) {
        try {
            // this is slightly different than generateObjectArray, in that we parse object, not object array
            elizaLogger.debug("Generating text...");
            elizaLogger.debug("Arrived at generateText", runtime, context, modelClass, modelProvider, returnUsage, tools, messages);
            let generateResponse = await generateText({
                runtime,
                context,
                modelClass,
                modelProvider,
                returnUsage,
                tools,
                messages,
            });

            let response: string;
            let usage: LanguageModelUsage | undefined;

            if (returnUsage) {
                response = (generateResponse as { response: string; usage: LanguageModelUsage }).response;
                usage = (generateResponse as { response: string; usage: LanguageModelUsage }).usage;
            } else {
                response = generateResponse as string;
                usage = undefined;
            }

            // HACK: would add this to handleProvider but ai package not yet compatible
            if (modelProvider === ModelProviderName.VENICE) {
                response = response
                    .replace(/<think>[\s\S]*?<\/think>\s*\n*/g, '');
            }

            const parsedResponse = parseJSONObjectFromText(response);
            if (parsedResponse) {
                return returnUsage ? { response: parsedResponse, usage } : parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateObject:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

export async function generateObjectArray({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<any[]> {
    if (!context) {
        elizaLogger.error("generateObjectArray context is empty");
        return [];
    }
    let retryDelay = 1000;

    while (true) {
        try {
            const response = await generateText({
                runtime,
                context,
                modelClass,
            });

            const parsedResponse = parseJsonArrayFromText(response as string);
            if (parsedResponse) {
                return parsedResponse;
            }
        } catch (error) {
            elizaLogger.error("Error in generateTextArray:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}

/**
 * Send a message to the model for generateText.
 * @param opts - The options for the generateText request.
 * @param opts.context The context of the message to be completed.
 * @param opts.stop A list of strings to stop the generateText at.
 * @param opts.model The model to use for generateText.
 * @param opts.frequency_penalty The frequency penalty to apply to the generateText.
 * @param opts.presence_penalty The presence penalty to apply to the generateText.
 * @param opts.temperature The temperature to apply to the generateText.
 * @param opts.max_context_length The maximum length of the context to apply to the generateText.
 * @returns The completed message.
 */
export async function generateMessageResponse({
    runtime,
    context,
    modelClass,
    returnUsage,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    returnUsage?: boolean;
}): Promise<Content | { response: Content, usage: LanguageModelUsage }> {
    const modelSettings = getModelSettings(runtime.modelProvider, modelClass);
    const max_context_length = modelSettings.maxInputTokens;

    context = await trimTokens(context, max_context_length, runtime);
    elizaLogger.debug("Context:", context);
    let retryLength = 1000; // exponential backoff
    let parsedContent;
    let usage;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        try {
            elizaLogger.log("Generating message response..");

            let response = await generateText({
                runtime,
                context,
                modelClass,
                returnUsage,
            });

            if (returnUsage) {
                // @ts-ignore
                usage = response.usage as LanguageModelUsage;
                // @ts-ignore
                response = response.response as string;

            }

            // try parsing the response as JSON, if null then try again
            parsedContent = parseJSONObjectFromText(response as string) as Content;
            if (parsedContent) {
                return !returnUsage ? parsedContent : { response: parsedContent, usage };
            }

            elizaLogger.debug("parsedContent is null, retrying");
            attempts++;

        } catch (error) {
            elizaLogger.error("ERROR:", error);
            attempts++;
            if (attempts < maxAttempts) {
                retryLength *= 2;
                await new Promise((resolve) => setTimeout(resolve, retryLength));
                elizaLogger.debug("Retrying...");
            }
        }
    }

    throw new Error("Failed to generate message response after 3 attempts");
}

export const generateImage = async (
    data: {
        prompt: string;
        width: number;
        height: number;
        count?: number;
        negativePrompt?: string;
        numIterations?: number;
        guidanceScale?: number;
        seed?: number;
        imageModelProvider?: ModelProviderName;
        modelId?: string;
        jobId?: string;
        stylePreset?: string;
        hideWatermark?: boolean;
        safeMode?: boolean;
        cfgScale?: number;
        returnRawResponse?: boolean;
        inpaint?: {
            strength: number;
            source_image_base64: string;
        }
    },
    runtime: IAgentRuntime
): Promise<{
    success: boolean;
    data?: string[];
    error?: any;
}> => {
    elizaLogger.info("data", data);

    // Always use VENICE as the provider
    const imageModelProvider = ModelProviderName.VENICE;
    elizaLogger.info("imageModelProvider", imageModelProvider);

    const modelSettings = getImageModelSettings(imageModelProvider);
    elizaLogger.info("modelSettings", modelSettings);
    if (!modelSettings) {
        elizaLogger.warn("No model settings found for the image model provider.");
        return { success: false, error: "No model settings available" };
    }
    const model = modelSettings.name;
    elizaLogger.info("Generating image with options:", {
        imageModelProvider,
        modelId: data.modelId,
        stylePreset: data.stylePreset,
        // inpaint: !!data.inpaint
    });

    // Always get the VENICE API key
    let apiKey: string | undefined;
    try {
        apiKey =  process.env.VENICE_API_KEY;
        elizaLogger.info("apikey", apiKey ? "[REDACTED]" : "undefined");
        if (!apiKey) {
            elizaLogger.error("VENICE_API_KEY is missing from runtime settings");
            return { success: false, error: "VENICE_API_KEY is missing" };
        }
    } catch (e) {
        elizaLogger.error("Error retrieving VENICE_API_KEY from runtime", e);
        return { success: false, error: "Failed to retrieve VENICE_API_KEY" };
    }

    // Defensive: check fetch exists
    if (typeof fetch !== "function") {
        elizaLogger.error("Global fetch is not available");
        return { success: false, error: "Global fetch is not available" };
    }

    let requestBody: any;
    try {
        requestBody = {
            model: data.modelId || model,
            prompt: data.prompt,
            cfg_scale: data.guidanceScale,
            negative_prompt: data.negativePrompt,
            width: data.width,
            height: data.height,
            steps: data.numIterations,
            safe_mode: data.safeMode,
            seed: data.seed,
            style_preset: data.stylePreset,
            hide_watermark: data.hideWatermark,
            inpaint: data.inpaint,
        };
        elizaLogger.info("Request body for Venice:", requestBody);
    } catch (e) {
        elizaLogger.error("Failed to construct request body for Venice", e);
        return { success: false, error: "Failed to construct request body" };
    }

    try {
        const response = await fetch(
            "https://api.venice.ai/api/v1/image/generate",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            }
        );
        elizaLogger.info("Venice fetch response status:", response.status);

        let result: any;
        try {
            result = await response.json();
        } catch (jsonErr) {
            elizaLogger.error("Failed to parse Venice response as JSON", jsonErr);
            return { success: false, error: "Failed to parse Venice response as JSON" };
        }
        elizaLogger.info("Venice result", result);

        if (!result.images || !Array.isArray(result.images)) {
            elizaLogger.error("Invalid response format from Venice AI", result);
            return { success: false, error: "Invalid response format from Venice AI" };
        }
        elizaLogger.info("Venice result.images", result.images);

        const base64s = result.images.map((base64String: string) => {
            if (!base64String) {
                elizaLogger.error("Empty base64 string in Venice AI response", result);
                throw new Error("Empty base64 string in Venice AI response");
            }
            return `data:image/png;base64,${base64String}`;
        });
        // elizaLogger.info("Venice base64s", base64s);
        return { success: true, data: base64s };
    } catch (error) {
        elizaLogger.error("Venice image generation failed", error);
        return { success: false, error: error };
    }
};

export const generateCaption = async (
    data: { imageUrl: string },
    runtime: IAgentRuntime
): Promise<{
    title: string;
    description: string;
}> => {
    const { imageUrl } = data;
    const imageDescriptionService =
        runtime.getService<IImageDescriptionService>(
            ServiceType.IMAGE_DESCRIPTION
        );

    if (!imageDescriptionService) {
        throw new Error("Image description service not found");
    }

    const resp = await imageDescriptionService.describeImage(imageUrl);
    return {
        title: resp.title.trim(),
        description: resp.description.trim(),
    };
};

/**
 * Configuration options for generating objects with a model.
 */
export interface GenerationOptions {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
    schema?: ZodSchema;
    schemaName?: string;
    schemaDescription?: string;
    stop?: string[];
    mode?: "auto" | "json" | "tool";
    experimental_providerMetadata?: Record<string, unknown>;
    // verifiableInference?: boolean;
    // verifiableInferenceAdapter?: IVerifiableInferenceAdapter;
    // verifiableInferenceOptions?: VerifiableInferenceOptions;
}

/**
 * Base settings for model generation.
 */
interface ModelSettings {
    prompt: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stop?: string[];
    experimental_telemetry?: TelemetrySettings;
}

/**
 * Generates structured objects from a prompt using specified AI models and configuration options.
 *
 * @param {GenerationOptions} options - Configuration options for generating objects.
 * @returns {Promise<any[]>} - A promise that resolves to an array of generated objects.
 * @throws {Error} - Throws an error if the provider is unsupported or if generation fails.
 */
export const generateObject = async ({
    runtime,
    context,
    modelClass,
    schema,
    schemaName,
    schemaDescription,
    stop,
    mode = "json",
}: // verifiableInference = false,
// verifiableInferenceAdapter,
// verifiableInferenceOptions,
GenerationOptions): Promise<GenerateObjectResult<unknown>> => {
    if (!context) {
        const errorMessage = "generateObject context is empty";
        console.error(errorMessage);
        throw new Error(errorMessage);
    }

    const provider = runtime.modelProvider;
    const modelSettings = getModelSettings(runtime.modelProvider, modelClass);
    const model = modelSettings.name;
    const temperature = modelSettings.temperature;
    const frequency_penalty = modelSettings.frequency_penalty;
    const presence_penalty = modelSettings.presence_penalty;
    const max_context_length = modelSettings.maxInputTokens;
    const max_response_length = modelSettings.maxOutputTokens;
    const experimental_telemetry = modelSettings.experimental_telemetry;
    const apiKey = runtime.token;

    try {
        context = await trimTokens(context, max_context_length, runtime);

        const modelOptions: ModelSettings = {
            prompt: context,
            temperature,
            maxTokens: max_response_length,
            frequencyPenalty: frequency_penalty,
            presencePenalty: presence_penalty,
            stop: stop || modelSettings.stop,
            experimental_telemetry: experimental_telemetry,
        };

        const response = await handleProvider({
            provider,
            model,
            apiKey,
            schema,
            schemaName,
            schemaDescription,
            mode,
            modelOptions,
            runtime,
            context,
            modelClass,
            // verifiableInference,
            // verifiableInferenceAdapter,
            // verifiableInferenceOptions,
        });

        return response;
    } catch (error) {
        console.error("Error in generateObject:", error);
        throw error;
    }
};

/**
 * Handles AI generation based on the specified provider.
 *
 * @param {ProviderOptions} options - Configuration options specific to the provider.
 * @returns {Promise<any[]>} - A promise that resolves to an array of generated objects.
 */
export async function handleProvider(
    options: ProviderOptions
): Promise<GenerationResult> {
    const {
        provider,
        runtime,
        context,
        modelClass,
        //verifiableInference,
        //verifiableInferenceAdapter,
        //verifiableInferenceOptions,
    } = options;
    switch (provider) {
        case ModelProviderName.OPENAI:
        case ModelProviderName.ETERNALAI:
        case ModelProviderName.ALI_BAILIAN:
        case ModelProviderName.VOLENGINE:
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
        case ModelProviderName.NANOGPT:
        case ModelProviderName.AKASH_CHAT_API:
        case ModelProviderName.LMSTUDIO:
            return await handleOpenAI(options);
        case ModelProviderName.ANTHROPIC:
        case ModelProviderName.CLAUDE_VERTEX:
            return await handleAnthropic(options);
        case ModelProviderName.GROK:
            return await handleGrok(options);
        case ModelProviderName.GROQ:
            return await handleGroq(options);
        case ModelProviderName.LLAMALOCAL:
            return await generateObjectDeprecated({
                runtime,
                context,
                modelClass,
            });
        case ModelProviderName.GOOGLE:
            return await handleGoogle(options);
        case ModelProviderName.MISTRAL:
            return await handleMistral(options);
        case ModelProviderName.REDPILL:
            return await handleRedPill(options);
        case ModelProviderName.OPENROUTER:
            return await handleOpenRouter(options);
        case ModelProviderName.OLLAMA:
            return await handleOllama(options);
        case ModelProviderName.DEEPSEEK:
            return await handleDeepSeek(options);
        case ModelProviderName.LIVEPEER:
            return await handleLivepeer(options);
        case ModelProviderName.SECRETAI:
            return await handleSecretAi(options);
        case ModelProviderName.NEARAI:
            return await handleNearAi(options);
        case ModelProviderName.BEDROCK:
            return await handleBedrock(options);
        default: {
            const errorMessage = `Unsupported provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }
}
/**
 * Handles object generation for OpenAI.
 *
 * @param {ProviderOptions} options - Options specific to OpenAI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOpenAI({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
}: ProviderOptions): Promise<GenerateObjectResult<unknown>> {
    const endpoint = runtime.character.modelEndpointOverride || getEndpoint(provider);
    const baseURL = getCloudflareGatewayBaseURL(runtime, "openai") || endpoint;
    const openai = createOpenAI({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: openai.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Anthropic models.
 *
 * @param {ProviderOptions} options - Options specific to Anthropic.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleAnthropic({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "auto",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    elizaLogger.debug("Handling Anthropic request with Cloudflare check");
    if (mode === "json") {
        elizaLogger.warn("Anthropic mode is set to json, changing to auto");
        mode = "auto";
    }
    const baseURL = getCloudflareGatewayBaseURL(runtime, "anthropic");
    elizaLogger.debug("Anthropic handleAnthropic baseURL:", { baseURL });

    const anthropic = createAnthropic({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    return await aiGenerateObject({
        model: anthropic.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Grok models.
 *
 * @param {ProviderOptions} options - Options specific to Grok.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGrok({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const grok = createOpenAI({
        apiKey,
        baseURL: models.grok.endpoint,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: grok.languageModel(model, { parallelToolCalls: false }),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Groq models.
 *
 * @param {ProviderOptions} options - Options specific to Groq.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGroq({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    elizaLogger.debug("Handling Groq request with Cloudflare check");
    const baseURL = getCloudflareGatewayBaseURL(runtime, "groq");
    elizaLogger.debug("Groq handleGroq baseURL:", { baseURL });

    const groq = createGroq({
        apiKey,
        baseURL,
        fetch: runtime.fetch
    });
    return await aiGenerateObject({
        model: groq.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Google models.
 *
 * @param {ProviderOptions} options - Options specific to Google.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleGoogle({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerateObjectResult<unknown>> {
    const google = createGoogleGenerativeAI({
        apiKey,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: google(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Mistral models.
 *
 * @param {ProviderOptions} options - Options specific to Mistral.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleMistral({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const mistral = createMistral({ fetch: runtime.fetch });
    return aiGenerateObject({
        model: mistral(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Redpill models.
 *
 * @param {ProviderOptions} options - Options specific to Redpill.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleRedPill({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const redPill = createOpenAI({
        apiKey,
        baseURL: models.redpill.endpoint,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: redPill.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for OpenRouter models.
 *
 * @param {ProviderOptions} options - Options specific to OpenRouter.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOpenRouter({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const openRouter = createOpenAI({
        apiKey,
        baseURL: models.openrouter.endpoint,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: openRouter.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Ollama models.
 *
 * @param {ProviderOptions} options - Options specific to Ollama.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleOllama({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const ollamaProvider = createOllama({
        baseURL: getEndpoint(provider) + "/api",
        fetch: runtime.fetch
    });
    const ollama = ollamaProvider(model);
    return aiGenerateObject({
        model: ollama,
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for DeepSeek models.
 *
 * @param {ProviderOptions} options - Options specific to DeepSeek.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleDeepSeek({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const openai = createOpenAI({
        apiKey,
        baseURL: models.deepseek.endpoint,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: openai.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Amazon Bedrock models.
 *
 * @param {ProviderOptions} options - Options specific to Amazon Bedrock.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleBedrock({
    model,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    provider,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const bedrockClient = bedrock(model);
    return aiGenerateObject({
        model: bedrockClient,
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

async function handleLivepeer({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode,
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    console.log("Livepeer provider api key:", apiKey);
    if (!apiKey) {
        throw new Error(
            "Livepeer provider requires LIVEPEER_GATEWAY_URL to be configured"
        );
    }

    const livepeerClient = createOpenAI({
        apiKey,
        baseURL: apiKey,
        fetch: runtime.fetch
    });
    return aiGenerateObject({
        model: livepeerClient.languageModel(model),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for Secret AI models.
 *
 * @param {ProviderOptions} options - Options specific to Secret AI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleSecretAi({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    provider,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const secretAiProvider = createOllama({
        baseURL: getEndpoint(provider) + "/api",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        fetch: runtime.fetch
    });
    const secretAi = secretAiProvider(model);
    return aiGenerateObject({
        model: secretAi,
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

/**
 * Handles object generation for NEAR AI models.
 *
 * @param {ProviderOptions} options - Options specific to NEAR AI.
 * @returns {Promise<GenerateObjectResult<unknown>>} - A promise that resolves to generated objects.
 */
async function handleNearAi({
    model,
    apiKey,
    schema,
    schemaName,
    schemaDescription,
    mode = "json",
    modelOptions,
    runtime,
}: ProviderOptions): Promise<GenerationResult> {
    const nearai = createOpenAI({
        apiKey,
        baseURL: models.nearai.endpoint,
        fetch: runtime.fetch
    });
    const settings = schema ? { structuredOutputs: true } : undefined;
    return aiGenerateObject({
        model: nearai.languageModel(model, settings),
        schema,
        schemaName,
        schemaDescription,
        mode,
        ...modelOptions,
    });
}

// Add type definition for Together AI response
interface TogetherAIImageResponse {
    data: Array<{
        url: string;
        content_type?: string;
        image_type?: string;
    }>;
}

// doesn't belong here
export async function generateTweetActions({
    runtime,
    context,
    modelClass,
}: {
    runtime: IAgentRuntime;
    context: string;
    modelClass: ModelClass;
}): Promise<ActionResponse | null> {
    let retryDelay = 1000;
    while (true) {
        try {
            const response = await generateText({
                runtime,
                context,
                modelClass,
            }) as string;
            elizaLogger.debug(
                "Received response from generateText for tweet actions:",
                response
            );
            const { actions } = parseActionResponseFromText(response.trim());
            if (actions) {
                elizaLogger.debug("Parsed tweet actions:", actions);
                return actions;
            } else {
                elizaLogger.debug("generateTweetActions no valid response");
            }
        } catch (error) {
            elizaLogger.error("Error in generateTweetActions:", error);
            if (
                error instanceof TypeError &&
                error.message.includes("queueTextCompletion")
            ) {
                elizaLogger.error(
                    "TypeError: Cannot read properties of null (reading 'queueTextCompletion')"
                );
            }
        }
        elizaLogger.log(`Retrying in ${retryDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay *= 2;
    }
}
