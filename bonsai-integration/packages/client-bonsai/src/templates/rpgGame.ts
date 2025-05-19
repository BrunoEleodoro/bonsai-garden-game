import {
    elizaLogger,
    ModelClass,
    composeContext,
    generateObjectDeprecated,
    type IAgentRuntime,
    ModelProviderName,
    getModelSettings,
} from "@elizaos/core";
import type { LanguageModelUsage } from "ai";
import { type ImageMetadata, type URI } from "@lens-protocol/metadata";
import type { Post, TextOnlyMetadata } from "@lens-protocol/client";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import z from "zod";
import pkg from "lodash";
const { uniq, uniqBy } = pkg;
import { walletOnly } from "@lens-chain/storage-client";
import {
    ImageRequirement,
    LaunchpadChain,
    TemplateCategory,
    TemplateName,
    type SmartMedia,
    type Template,
    type TemplateHandlerResponse,
    type TemplateUsage,
} from "../utils/types";
import { formatMetadata } from "../services/lens/createPost";
import { isMediaStale, getLatestComments, getVoteWeightFromBalance } from "../utils/utils";
import { uploadJson, cacheJsonStorj } from "../utils/ipfs";
import { fetchAllCollectorsFor, fetchAllCommentsFor, fetchAllUpvotersFor } from "../services/lens/posts";
import { balanceOfBatched } from "../utils/viem";
import { storageClient, LENS_CHAIN_ID, LENS_CHAIN } from "../services/lens/client";
import { BONSAI_PROTOCOL_FEE_RECIPIENT } from "../utils/constants";
import { v4 as uuidv4 } from 'uuid';

const OPEN_ROUTER_API_KEY="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"

// RPG Game: 4 options, no image generation

export const nextPageTemplate = `
# Instructions
You are generating the next page in a role-playing game (RPG) adventure story.
The story is defined by the Context (the overall setting and premise), Writing Style, Character Personalities, and Previous Pages (each condensed into this format: CHAPTER_NAME; DECISION_TAKEN).
Based on this information, write the next page. If there are no Previous Pages, then simply produce the first page which sets up the rest of the story.
Each "page" should be roughly 2 short paragraphs (4-5 sentences each) describing the action, situation, or challenge the player faces.
The story should highlight the personalities of the main characters, and what they say to the players or each other, as appropriate for the scene.
End the new page with four distinct decision choices that the player can pick from. The decisions should be relevant to the current situation and offer meaningful, different paths or actions.
Start the page with a descriptive chapter name that can be used for future prompts to summarize the page. Do not include the chapter number in the name.

After you generate the page, format your response into a JSON object with these properties:
\`\`\`json
{
    chapterName: string,
    content: string,
    decisions: string[4]
}
\`\`\`

# Context
{{context}}

# Writing Style
{{writingStyle}}

# Character Personalities
{{characterPersonalities}}

# Previous Pages
{{previousPages}}

Do not acknowledge this request, simply respond with the JSON object.
`;

export const decisionTemplate = `
# Instructions
You must choose one of the four Decisions based on the Comments. When processing the comments, you must account for any references to the decisions. For example, a comment might say "option A", "option 1", or include part of a decision's text; all should map to the correct decision.
Each comment is formatted as: { content: string, votes: number }.
Important: For each comment that maps to a decision, use the vote count exactly as provided (i.e., the integer in the "votes" field) without applying any scaling, rounding, or additional arithmetic transformations. For example, if a decision receives a comment with { votes: 22 }, then add exactly 22 to that decision's total.
Map each comment to its corresponding decision by matching textual cues, then sum the votes for each decision by adding up the exact vote values from all matching comments.
Return the result as a JSON object with the decisions and their corresponding totalVotes, sorted in descending order by totalVotes.
The output should be a JSON block with the following format: \`\`\`json { "decisions": [{ "content": string, "totalVotes": number }] } \`\`\`

# Decisions
{{decisions}}

# Comments
{{comments}}

Do not acknowledge this request, simply respond with the JSON block wrapped in triple backticks with 'json' language identifier.
`;

type NextPageResponse = {
    chapterName: string;
    content: string;
    decisions: [string, string, string, string];
}

type DecisionResponse = {
    decisions: {
        content: string;
        totalVotes: number;
    }[]
}

type TemplateData = {
    context: string;
    writingStyle: string;
    characterPersonalities: string;
    chapterName: string;
    decisions: string[];
    previousPages?: string[];
    minCommentUpdateThreshold?: number;
}

const DEFAULT_MIN_ENGAGEMENT_UPDATE_THREHOLD = 1; // at least 1 upvote/comment before updating

/**
 * Handles the generation and updating of an RPG adventure post.
 * This function either generates a new RPG preview based on initial template data
 * or refreshes an existing RPG by evaluating new comments and votes to decide the next page.
 *
 * @param {IAgentRuntime} runtime - The eliza runtime environment providing utilities for generating content.
 * @param {SmartMedia} [media] - The current, persisted media object associated with the RPG, used for updates.
 * @param {TemplateData} [_templateData] - Initial data for generating a new RPG preview, used when not refreshing.
 * @returns {Promise<TemplateHandlerResponse | null>} A promise that resolves to the response object containing the new page preview, uri (optional), and updated template data, or null if the operation cannot be completed.
 */
const rpgGame = {
    handler: async (
        runtime: IAgentRuntime,
        media?: SmartMedia,
        _templateData?: TemplateData,
        options?: { forceUpdate: boolean },
    ): Promise<TemplateHandlerResponse | undefined> => {
        const refresh = !!media?.templateData;
        elizaLogger.info(`Running template (refresh: ${refresh}):`, TemplateName.RPG_GAME ?? "RPG_GAME");

        // either we are refreshing the persisted `media` object or we're generating a preview using `_templateData`
        const templateData = refresh ? media?.templateData as TemplateData : _templateData;
        if (!templateData) {
            elizaLogger.error("Missing template data");
            return;
        }

        const totalUsage: TemplateUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            imagesCreated: 0,
        };

        try {
            if (refresh) {
                let comments: Post[]; // latest comments to evaluate for the next decision

                // if the post not stale, check if we've passed the min comment threshold
                if (isMediaStale(media as SmartMedia) || options?.forceUpdate) {
                    elizaLogger.info(`media is stale for post: ${media?.postId}`);

                    try {
                        const allComments = await fetchAllCommentsFor(media?.postId as string);
                        comments = getLatestComments(media as SmartMedia, allComments);
                        comments = uniqBy(comments, 'comment.author.address');
                        elizaLogger.info(`latest, unique comments: ${comments.length}`);
                        const threshold = (media?.templateData as TemplateData).minCommentUpdateThreshold ||
                            DEFAULT_MIN_ENGAGEMENT_UPDATE_THREHOLD;
                        if (comments.length < threshold) {
                            elizaLogger.info(`rpgGame:: post ${media?.postId} is stale but has not met comment threshold; skipping`);
                            return { metadata: undefined, totalUsage };
                        }
                    } catch (error) {
                        console.log(error);
                        return;
                    }
                } else {
                    // do not update if the media isn't stale; we're paying for generations
                    elizaLogger.info(`media not stale for post: ${media?.postId}...`);
                    return { metadata: undefined, totalUsage };
                }

                // fetch the token balances for each comment / upvote to use weighted votes
                const allCollectors = await fetchAllCollectorsFor(media?.postId as string);
                const commentsWeighted = await Promise.all(comments.map(async (comment) => {
                    let voters = await fetchAllUpvotersFor(comment.id);
                    voters.push(comment.author.address);
                    voters = uniq(voters); // discard upvotes from the same user
                    voters = voters.filter((account) => allCollectors.includes(account)); // only collectors

                    // If no token is present, each voter gets 1 vote
                    if (!media?.token?.address) {
                        return {
                            content: (comment.metadata as TextOnlyMetadata).content,
                            votes: voters.length,
                        };
                    }

                    // Token-weighted voting
                    const balances = await balanceOfBatched(
                        media.token.chain === LaunchpadChain.BASE ? base : LENS_CHAIN,
                        voters,
                        media.token.address as `0x${string}`
                    );
                    return {
                        content: (comment.metadata as TextOnlyMetadata).content,
                        votes: balances.reduce((acc, b) => acc + getVoteWeightFromBalance(b), 0),
                    };
                }));

                console.log({ decisions: templateData.decisions, comments: JSON.stringify(commentsWeighted) });
                const context = composeContext({
                    // @ts-expect-error State
                    state: { decisions: templateData.decisions, comments: JSON.stringify(commentsWeighted) },
                    template: decisionTemplate,
                });

                // evaluate next decision
                elizaLogger.info("generating decision response:: generateObjectDeprecated");
                const { response, usage } = (await generateObjectDeprecated({
                    runtime,
                    context,
                    modelClass: ModelClass.SMALL,
                    modelProvider: ModelProviderName.OPENAI,
                    returnUsage: true,
                })) as unknown as { response: DecisionResponse, usage: LanguageModelUsage };
                elizaLogger.info("generated", response);
                elizaLogger.info("usage", usage);

                totalUsage.promptTokens += usage.promptTokens;
                totalUsage.completionTokens += usage.completionTokens;
                totalUsage.totalTokens += usage.totalTokens;

                let decision: string;
                if (!response.decisions?.length) {
                    elizaLogger.error(`Failed to retrieve decisions for post: ${media?.postId}; using the first one`);
                    decision = templateData.decisions[0];
                } else {
                    decision = response.decisions[0].content;
                }

                // push to templateData.previousPages to be immediately used for a new generation
                if (templateData.previousPages) {
                    templateData.previousPages.push(`${templateData.chapterName}; ${decision}`);
                } else {
                    templateData.previousPages = [`${templateData.chapterName}; ${decision}`];
                }
                console.log("templateData.previousPages", templateData.previousPages);
            }

            const context = composeContext({
                // @ts-expect-error we don't need the full State object here to produce the context
                state: {
                    context: templateData.context,
                    previousPages: templateData.previousPages || '',
                    writingStyle: templateData.writingStyle,
                    characterPersonalities: templateData.characterPersonalities || ''
                },
                template: nextPageTemplate,
            });

            elizaLogger.info("generating page:: generateObjectDeprecated");
            const { response: page, usage } = (await generateObjectDeprecated({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                modelProvider: ModelProviderName.OPENROUTER,
                returnUsage: true,
            })) as unknown as { response: NextPageResponse, usage: LanguageModelUsage };
            elizaLogger.info("generated", page);
            elizaLogger.info("usage", usage);

            totalUsage.promptTokens += usage.promptTokens;
            totalUsage.completionTokens += usage.completionTokens;
            totalUsage.totalTokens += usage.totalTokens;

            const text = `${page.chapterName}
${page.content}

Option A) ${page.decisions[0]}

Option B) ${page.decisions[1]}

Option C) ${page.decisions[2]}

Option D) ${page.decisions[3]}
`;

            let metadata: ImageMetadata | undefined;
            let persistVersionUri: string | undefined;
            if (refresh) {
                const url = await storageClient.resolve(media?.uri as URI);
                const json: ImageMetadata = await fetch(url).then(res => res.json());
                const signer = privateKeyToAccount(process.env.LENS_STORAGE_NODE_PRIVATE_KEY as `0x${string}`);
                const acl = walletOnly(signer.address, LENS_CHAIN_ID);

                // Save previous version to storj (text only, no image)
                let versionCount = media?.versionCount || 0;
                const versionMetadata = formatMetadata({
                    text: json.lens.content as string,
                    image: undefined,
                    attributes: json.lens.attributes,
                    media: {
                        category: TemplateCategory.EVOLVING_POST,
                        name: TemplateName.RPG_GAME ?? "RPG_GAME",
                    },
                });

                const versionResult = await cacheJsonStorj({
                    id: `${json.lens.id}-version-${versionCount}.json`,
                    data: versionMetadata
                });

                if (versionResult.success) {
                    persistVersionUri = versionResult.url;
                } else {
                    elizaLogger.error('Failed to cache version metadata:', versionResult.error);
                }

                // edit the metadata (text only, no image)
                metadata = formatMetadata({
                    text,
                    image: undefined,
                    attributes: json.lens.attributes,
                    media: {
                        category: TemplateCategory.EVOLVING_POST,
                        name: TemplateName.RPG_GAME ?? "RPG_GAME",
                    },
                }) as ImageMetadata;
                await storageClient.updateJson(media?.uri, metadata, signer, { acl });
            }

            return {
                preview: {
                    text,
                    image: undefined,
                },
                metadata,
                refreshMetadata: refresh,
                updatedTemplateData: { ...templateData, decisions: page.decisions, chapterName: page.chapterName },
                persistVersionUri,
                totalUsage,
            }
        } catch (error) {
            console.log(error);
            elizaLogger.error("handler failed", error);
        }
    },
    clientMetadata: {
        protocolFeeRecipient: BONSAI_PROTOCOL_FEE_RECIPIENT,
        category: TemplateCategory.EVOLVING_POST,
        name: TemplateName.RPG_GAME ?? "RPG_GAME",
        displayName: "RPG Game",
        description: "The creator sets the stage for an evolving RPG adventure. Collectors & token holders decide the direction of the story by choosing among four options.",
        image: "https://link.storjshare.io/raw/jxejf7rwn2hq3lhwh3v72g7bdpxa/bonsai/adventureTime.png",
        options: {
            allowPreview: true,
            allowPreviousToken: true,
            imageRequirement: ImageRequirement.NONE,
        },
        defaultModel: getModelSettings(ModelProviderName.OPENROUTER, ModelClass.SMALL)?.name,
        templateData: {
            form: z.object({
                context: z.string().describe("Set the initial context and background for your RPG story. This will help guide the narrative direction. [placeholder: A party of adventurers enters a mysterious dungeon; POV: The party leader]"),
                writingStyle: z.string().describe("Define the writing style and tone - e.g. epic, dark, humorous, etc. [placeholder: Gritty, suspenseful]"),
                characterPersonalities: z.string().describe("Describe the main characters' personalities and how they interact or speak. [placeholder: The wizard is sarcastic and clever; the warrior is brave but impulsive; the rogue is quiet and observant.]"),
            })
        }
    }
} as Template;

export default rpgGame;
