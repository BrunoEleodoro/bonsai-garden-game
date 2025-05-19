import {
  elizaLogger,
  composeContext,
  type IAgentRuntime,
  ModelProviderName,
  generateImage,
  generateText,
  ModelClass,
} from "@elizaos/core";
import { type ImageMetadata, MediaImageMimeType, type URI } from "@lens-protocol/metadata";
import type { Post, TextOnlyMetadata } from "@lens-protocol/client";
import { chains } from "@lens-chain/sdk/viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { walletOnly } from "@lens-chain/storage-client";
import type { Account } from "viem";
import z from "zod";
import pkg from "lodash";
const { orderBy, uniq, uniqBy } = pkg;
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
import { cacheJsonStorj, cacheImageStorj, parseBase64Image, pinFile, uploadJson, uriToBuffer } from "../utils/ipfs";
import { fetchAllCollectorsFor, fetchAllCommentsFor, fetchAllUpvotersFor } from "../services/lens/posts";
import { balanceOfBatched } from "../utils/viem";
import { LENS_CHAIN, LENS_CHAIN_ID, storageClient } from "../services/lens/client";
import { BONSAI_PROTOCOL_FEE_RECIPIENT } from "../utils/constants";
import { refresh } from "@lens-protocol/client/actions";
import { v4 as uuidv4 } from 'uuid';

export const nextHeroImageTemplate = `
# Instructions
Create an image of the RPG hero based on the following personality traits and actions. Use the Personality and Action to generate the hero's appearance and pose.
# Personality
{{personality}}
# Action
{{action}}
`;

type BonsaiGardenTemplateData = {
  personality: string;
  action: string;
  modelId?: string;
  stylePreset?: string;
  minCommentUpdateThreshold?: number;
}

const DEFAULT_HERO_IMAGE_MODEL_ID = "venice-sd35"; // most creative
const DEFAULT_MIN_ENGAGEMENT_UPDATE_THREHOLD = 1; // at least 1 upvote/comment before updating

/**
 * Handles the generation and updating of a "Bonsai Garden RPG Hero" type post.
 * This function refreshes an existing post by evaluating new comments and votes to decide the evolution of the hero's image.
 *
 * @param {IAgentRuntime} runtime - The eliza runtime environment providing utilities for generating content and images.
 * @param {boolean} refresh - Flag indicating whether to generate a new page or update an existing one.
 * @param {SmartMedia} [media] - The current, persisted media object associated with the adventure, used for updates.
 * @param {BonsaiGardenTemplateData} [_templateData] - Initial data for generating a new adventure preview, used when not refreshing.
 * @returns {Promise<TemplateHandlerResponse | null>} A promise that resolves to the response object containing the new hero image preview, uri (optional), and updated template data, or null if the operation cannot be completed.
 */
const bonsaiGarden = {
  handler: async (
    runtime: IAgentRuntime,
    media?: SmartMedia,
    _templateData?: BonsaiGardenTemplateData,
    options?: { forceUpdate: boolean },
  ): Promise<TemplateHandlerResponse | undefined> => {
    const refresh = !!media?.templateData;
    elizaLogger.info(`Running template (refresh: ${refresh}):`, TemplateName.BONSAI_GARDEN);

    if (!media?.templateData) {
      elizaLogger.error("Missing template data");
      return;
    }

    const templateData = media.templateData as BonsaiGardenTemplateData;

    const totalUsage: TemplateUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      imagesCreated: 0,
    };

    try {
      let comments: Post[]; // latest comments to evaluate for the next decision

      // if the post not stale, check if we've passed the min comment threshold
      if (isMediaStale(media as SmartMedia) || options?.forceUpdate) {
        elizaLogger.info(`bonsaiGarden:: post ${media?.postId} is stale`);
        const allComments = await fetchAllCommentsFor(media?.postId as string);
        comments = getLatestComments(media as SmartMedia, allComments);
        comments = uniqBy(comments, 'comment.author.address');
        const threshold = (media?.templateData as BonsaiGardenTemplateData).minCommentUpdateThreshold ||
          DEFAULT_MIN_ENGAGEMENT_UPDATE_THREHOLD;
        if (comments.length < threshold) {
          elizaLogger.info(`bonsaiGarden:: post ${media?.postId} is stale but has not met comment threshold; skipping`);
          return { metadata: undefined, totalUsage };
        }
      } else {
        // do not update if the media was recently updated
        elizaLogger.info(`bonsaiGarden:: post ${media?.postId} is not stale; skipping`);
        return { metadata: undefined, totalUsage };
      }

      // fetch the token balances for each comment / upvote to use weighted votes
      const allCollectors = await fetchAllCollectorsFor(media?.postId as string);
      const commentsWeighted = await Promise.all(comments.map(async (comment) => {
        let voters = await fetchAllUpvotersFor(comment.id);
        voters.push(comment.author.address);
        voters = uniq(voters); // discard upvotes from the same user
        voters = voters.filter((account) => allCollectors.includes(account)); // only collectors

        // If no token is present, each collector gets 1 vote
        if (!media?.token?.address) {
          return {
            content: (comment.metadata as TextOnlyMetadata).content,
            votes: voters.length, // simple 1 vote per voter
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

      const url = await storageClient.resolve(media?.uri as URI);
      const json: ImageMetadata = await fetch(url).then(res => res.json());
      const imageUri = json.lens.image.item;
      const imageUrl = await storageClient.resolve(imageUri as URI);

      // For RPG hero, we expect comments to suggest personality and action traits
      // We'll use the most upvoted comment as the new hero's definition
      const topComment = orderBy(commentsWeighted, 'votes', 'desc')[0].content;
      // Try to extract personality and action from the comment (simple split, could be improved)
      let [personality, action] = topComment.split("|");
      if (!action) {
        // fallback: treat the whole comment as personality, and use a default action
        action = "standing heroically";
      }
      personality = personality?.trim() || "Brave, clever, and kind";
      action = action?.trim() || "standing heroically";

      let imageResponse;
      let attempts = 0;
      const MAX_ATTEMPTS = 2;
      while (attempts < MAX_ATTEMPTS) {
        // const firstAttempt = attempts === 0;
        const firstAttempt = false;

        let imagePrompt: string;
        if (firstAttempt) {
          imagePrompt = composeContext({
            // @ts-expect-error we don't need the full State object here to produce the context
            state: {
              personality,
              action
            },
            template: nextHeroImageTemplate,
          });
        } else {
          const { response, usage } = await generateText({
            runtime,
            modelClass: ModelClass.MEDIUM,
            modelProvider: ModelProviderName.VENICE,
            returnUsage: true,
            messages: [{
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Produce a prompt for an image of an RPG hero with the following personality and action: Personality: ${personality}. Action: ${action}. Only reply with the new image prompt, and be concise so to successfully prompt a new image.`
                },
                {
                  type: "image",
                  image: imageUrl
                }
              ]
            }]
          }) as { response: string, usage: TemplateUsage };

          totalUsage.promptTokens += usage.promptTokens;
          totalUsage.completionTokens += usage.completionTokens;
          totalUsage.totalTokens += usage.totalTokens;
          imagePrompt = response;
        }

        if (firstAttempt) elizaLogger.info("generating hero image with inpaint, context: ", imageUrl, imagePrompt);
        else elizaLogger.info("generating new hero image using text: ", imagePrompt);
        imageResponse = await generateImage(
          {
            prompt: imagePrompt,
            width: 1024,
            height: 1024,
            imageModelProvider: ModelProviderName.VENICE,
            modelId: templateData.modelId || DEFAULT_HERO_IMAGE_MODEL_ID,
            stylePreset: templateData.stylePreset,
            inpaint: firstAttempt ? {
              strength: 50,
              source_image_base64: await fetch(imageUrl)
                .then(res => res.arrayBuffer())
                .then(buffer => Buffer.from(buffer).toString('base64'))
            } : undefined
          },
          runtime
        );

        totalUsage.imagesCreated += 1;

        if (imageResponse.success) break;
        attempts++;
      }

      if (!imageResponse.success) {
        throw new Error("Failed to generate hero image after multiple attempts");
      }

      // save previous version to storj
      let persistVersionUri: string | undefined;
      // cache image to storj
      const storjResult = await cacheImageStorj({ id: uuidv4(), buffer: await uriToBuffer(imageUri) });
      if (storjResult.success && storjResult.url) {
          // upload version to storj for versioning
          const versionMetadata = formatMetadata({
              text: json.lens.content as string,
              image: {
                  url: storjResult.url,
                  type: MediaImageMimeType.PNG // see generation.ts the provider
              },
              attributes: json.lens.attributes,
              media: {
                  category: TemplateCategory.BONSAI_GARDEN,
                  name: TemplateName.BONSAI_GARDEN,
              },
          });

          let versionCount = media?.versionCount || 0;
          const versionResult = await cacheJsonStorj({
              id: `${json.lens.id}-version-${versionCount}.json`,
              data: versionMetadata
          });

          if (versionResult.success) {
              persistVersionUri = versionResult.url;
          } else {
              elizaLogger.error('Failed to cache version metadata:', versionResult.error);
          }
      }

      let signer: Account;
      let acl;
      let file;
      try {
        signer = privateKeyToAccount(process.env.LENS_STORAGE_NODE_PRIVATE_KEY as `0x${string}`);
        acl = walletOnly(signer.address, LENS_CHAIN_ID);
        file = parseBase64Image(imageResponse);

        if (!file) throw new Error("Failed to parse base64 hero image");

        await storageClient.editFile(imageUri, file, signer, { acl });
      } catch (error) {
        console.log(error);
        throw new Error("failed");
      }

      return { persistVersionUri, totalUsage, refreshMetadata: refresh }
    } catch (error) {
      console.log(error);
      elizaLogger.error("handler failed", error);
    }
  },
  clientMetadata: {
    protocolFeeRecipient: BONSAI_PROTOCOL_FEE_RECIPIENT,
    category: TemplateCategory.BONSAI_GARDEN,
    name: TemplateName.BONSAI_GARDEN,
    displayName: "Bonsai Garden RPG Hero",
    description: "Define your RPG hero's personality and actions. Collect the post, buy tokens, and interact (replies, upvotes) to evolve the hero's image.",
    image: "https://link.storjshare.io/raw/jwq56rwpuhhle4k7tjbxyfd4l37q/bonsai/heroPresent.png",
    options: {
      allowPreview: true,
      allowPreviousToken: true,
      imageRequirement: ImageRequirement.REQUIRED,
      requireContent: false,
    },
    templateData: {
      form: z.object({
        personality: z.string().describe("Describe your hero's personality traits - e.g. brave, clever, kind. [placeholder: Brave, clever, kind]"),
        action: z.string().describe("Describe what your hero is doing - e.g. fighting a dragon, exploring ruins. [placeholder: Standing heroically]"),
        modelId: z.string().nullish().describe("Optional: Specify an AI model to use for image generation"),
        stylePreset: z.string().nullish().describe("Optional: Choose a style preset to use for image generation"),
      })
    }
  }
} as Template;

export default bonsaiGarden;
