import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import { type Server as HttpServer, createServer } from "node:http";
import {
  settings,
  type IAgentRuntime,
  type UUID,
  Service,
  elizaLogger,
  ServiceType,
} from "@elizaos/core";
import type Redis from "ioredis";
import type { Collection, MongoClient } from "mongodb";
import type { URI } from "@lens-protocol/metadata";
import { walletOnly } from "@lens-chain/storage-client";
import redisClient from "./services/redis";
import {
  type CreateTemplateRequestParams,
  type LaunchpadToken,
  type SmartMedia,
  type SmartMediaBase,
  SmartMediaStatus,
  type Template,
  type TemplateName,
  type TemplateUsage
} from "./utils/types";
import verifyLensId from "./middleware/verifyLensId";
import verifyApiKeyOrLensId from "./middleware/verifyApiKeyOrLensId";
import { getClient, initCollections } from "./services/mongo";
import adventureTimeTemplate from "./templates/adventureTime";
import evolvingArtTemplate from "./templates/evolvingArt";
import infoAgentTemplate from "./templates/infoAgent";
import rpgGameTemplate from "./templates/rpgGame";
import bonsaiGardenTemplate from "./templates/bonsaiGarden";
import TaskQueue from "./utils/taskQueue";
import { refreshMetadataFor, refreshMetadataStatusFor } from "./services/lens/refreshMetadata";
import { formatSmartMedia } from "./utils/utils";
import { BONSAI_CLIENT_VERSION, DEFAULT_FREEZE_TIME, FREE_GENERATIONS_PER_HOUR, PREMIUM_TEMPLATES } from "./utils/constants";
import { LENS_CHAIN_ID } from "./services/lens/client";
import { canUpdate, decrementCredits, DEFAULT_MODEL_ID, minCreditsForUpdate } from "./utils/apiCredits";
import { fetchPostById } from "./services/lens/posts";
import adventureTimeVideo from "./templates/adventureTimeVideo";
import multer from "multer";
import path from "node:path";

/**
 * BonsaiClient provides an Express server for managing smart media posts on Lens Protocol.
 * It handles creation, updates, and management of dynamic NFT content.
 */
class BonsaiClient {
  private app: express.Application;
  private server: HttpServer;

  private redis: Redis;
  private mongo: { client?: MongoClient, media?: Collection };

  private tasks: TaskQueue = new TaskQueue();
  private cache: Map<UUID, SmartMediaBase> = new Map(); // agentId => preview
  private agents: Map<string, IAgentRuntime> = new Map();
  private templates: Map<TemplateName, Template> = new Map();

  /**
   * Initializes a new BonsaiClient instance with Express server, Redis, and MongoDB connections.
   * Sets up CORS, body parsing, and required middleware.
   */
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.redis = redisClient;
    this.mongo = {};

    // Configure multer for memory storage
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fieldSize: 50 * 1024 * 1024, // 50MB limit for field size
        fileSize: 50 * 1024 * 1024, // 50MB limit for file size
      }
    });

    this.app.use(cors());
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: true }));

    this.initialize();

    /**
     * GET /metadata
     * Retrieves the configuration for this eliza server including server domain, registered template metadata,
     * bonsai client version, and storage acl
     * @returns {Object} domain, version, templates, acl
     */
    this.app.get(
      "/metadata",
      async (_: express.Request, res: express.Response) => {
        const templates = Array.from(this.templates.values()).map(template => ({
          ...template.clientMetadata,
          templateData: {
            ...template.clientMetadata.templateData,
            form: template.clientMetadata.templateData.form.shape // serialize the zod object
          },
          estimatedCost: minCreditsForUpdate[template.clientMetadata.name]
        }));
        res.status(200).json({
          domain: process.env.DOMAIN as string,
          version: BONSAI_CLIENT_VERSION,
          templates,
          acl: walletOnly(process.env.LENS_STORAGE_NODE_ACCOUNT as `0x${string}`, LENS_CHAIN_ID)
        })
      }
    );

    // TODO: use socketio logic from client-orb with try... catch and ws emit
    /**
     * POST /post/create-preview
     * Generates a preview for a new smart media post before creation.
     *
     * @requires verifyLensId middleware
     * @param {Object} req.body.data - JSON data containing category, templateName, and templateData
     * @param {Object} req.body.image - Uploaded image file
     * @returns {Object} Preview data with agentId, preview content
     * @throws {400} If invalid JSON data in form field
     */
    this.app.post(
      "/post/create-preview",
      verifyLensId,
      upload.single('image'),
      async (req: express.Request, res: express.Response) => {
        const creator = req.user?.sub as `0x${string}`;

        // Parse the templateData from the form field
        let templateData, category, templateName;
        try {
          const formData = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body.data;
          templateData = formData.templateData;
          category = formData.category;
          templateName = formData.templateName;
        } catch (error) {
          console.log(error);
          res.status(400).json({ error: "Invalid JSON data in form field" });
          return;
        }

        // check if user has enough credits (for premium templates)
        if (PREMIUM_TEMPLATES.includes(templateName)) {
          if (!await canUpdate(creator, templateName)) {
            res.status(403).json({ error: `not enough credits to generate preview for: ${templateName}` });
            return;
          }
        }

        // If there's an uploaded file, add it to templateData
        if (req.file) {
          const imageData = req.file.buffer.toString('base64');
          templateData = {
            ...templateData,
            imageData: `data:${req.file.mimetype};base64,${imageData}`
          };
        }

        const runtime = this.agents.get(process.env.GLOBAL_AGENT_ID as UUID);
        const template = this.templates.get(templateName);
        if (!template) {
          res.status(400).json({ error: `templateName: ${templateName} not registered` });
          return;
        }

        elizaLogger.info(`templateData: ${templateData}`);

        // generate the preview and cache it for the create step
        const response = await template.handler(runtime as IAgentRuntime, undefined, templateData);
        const media = formatSmartMedia(
          creator,
          category,
          templateName,
          response?.updatedTemplateData || templateData
        );
        await this.cachePreview(media);

        // decrement credits or update the free counter
        this.handlePreviewCredits(template.clientMetadata.name, creator, response?.totalUsage, template.clientMetadata.defaultModel);

        res.status(200).json({ agentId: media.agentId, preview: response?.preview });
      }
    );

    /**
     * POST /post/create
     * Creates a new smart media post after the Lens post has been created.
     *
     * @requires verifyLensId middleware
     * @param {Object} req.body.agentId - Optional ID from preview
     * @param {Object} req.body.params - Optional creation parameters if no preview
     * @param {string} req.body.postId - Lens post ID
     * @param {string} req.body.uri - Uri (lens storage) of the post metadata, with ACL set to walletOnly(process.env.LENS_STORAGE_NODE_ACCOUNT)
     * @param {Object} req.body.token - Associated launchpad token
     * @returns {Object} Created smart media object
     * @throws {400} If neither agentId nor params are provided
     * @throws {400} If preview not found for agentId
     */
    this.app.post(
      "/post/create",
      verifyLensId,
      async (req: express.Request, res: express.Response) => {
        const creator = req.user?.sub as `0x${string}`;
        const {
          agentId,
          params,
          postId,
          uri,
          token
        }: {
          agentId?: UUID,
          params?: CreateTemplateRequestParams,
          postId: string,
          uri: URI,
          token?: LaunchpadToken,
        } = req.body;

        let media: SmartMedia;
        if (agentId) {
          const preview = this.cache.get(agentId as UUID);
          if (!preview) {
            res.status(400).json({ error: "preview not found" });
            return;
          }
          media = formatSmartMedia(
            creator,
            preview.category,
            preview.template,
            preview.templateData,
            postId,
            uri,
            token
          ) as SmartMedia;

          this.deletePreview(agentId); // remove from memory cache
        } else if (params) {
          const runtime = this.agents.get(process.env.GLOBAL_AGENT_ID as UUID);
          const template = this.templates.get(params.templateName);
          if (!template) {
            res.status(400).json({ error: `templateName: ${params.templateName} not registered` });
            return;
          }

          // check if user has enough credits
          if (!await canUpdate(creator, params.templateName)) {
            res.status(403).json({ error: `not enough credits to generate preview for: ${params.templateName}` });
            return;
          }

          // generate the first page
          const response = await template.handler(runtime as IAgentRuntime, undefined, params.templateData);
          media = formatSmartMedia(
            creator,
            params.category,
            params.templateName,
            response?.updatedTemplateData || params.templateData,
            postId,
            uri,
            token
          ) as SmartMedia;
        } else {
          res.status(400).json({ error: "missing agentId or params" });
          return;
        }

        await this.cachePost(media);
        this.mongo.media?.insertOne({
          ...media,
          versions: [],
          status: SmartMediaStatus.ACTIVE,
        });

        res.status(200).send(media);
      }
    );

    /**
     * GET /post/:postId
     * Retrieves all persisted data for a smart media post.
     *
     * @param {string} postId - Lens post ID
     * @param {boolean} withVersions - Optional flag to include version history
     * @returns {Object} Post URI, update timestamp status, , and optional versions
     * @throws {404} If post not found
     */
    this.app.get(
      "/post/:postId",
      async (req: express.Request, res: express.Response) => {
        const { postId } = req.params;
        const { withVersions } = req.query;
        const data = await this.getPost(postId as string);

        if (data) {
          let versions: string[] | undefined = data.versions;
          let status: SmartMediaStatus | undefined = data.status;
          let featured: boolean | undefined;

          if (withVersions && !(versions || status)) {
            const doc = await this.mongo.media?.findOne(
              { postId },
              { projection: { _id: 0, versions: { $slice: -10 }, status: 1, featured: 1 } }
            );
            versions = doc?.versions;
            status = doc?.status;
            featured = doc?.featured;
          }

          const template = this.templates.get(data.template);
          if (!template) throw new Error("template not found");
          res.status(200).json({
            ...data,
            isProcessing: this.tasks.isProcessing(postId as string),
            versions,
            protocolFeeRecipient: template?.clientMetadata.protocolFeeRecipient,
            description: template?.clientMetadata.description,
            estimatedCost: minCreditsForUpdate[template.clientMetadata.name],
            status,
            featured,
          });
        } else {
          res.status(404).send();
        }
      }
    );

    /**
     * POST /post/:postId/update
     * Triggers an update process for a smart media post.
     *
     * @requires verifyApiKeyOrLensId middleware
     * @param {string} postId - Lens post ID
     * @returns {Object} Processing status
     * @throws {404} If post not found
     */
    this.app.post(
      "/post/:postId/update",
      verifyApiKeyOrLensId,
      async (req: express.Request, res: express.Response) => {
        const { postId } = req.params;
        const { forceUpdate } = req.body;

        if (this.tasks.isProcessing(postId)) {
          res.status(204).json({ status: "processing" });
          return;
        }

        const data = await this.getPost(postId as string);
        if (!data) {
          res.status(404).send();
          return;
        }

        if (forceUpdate && (data.creator !== req.user?.sub as `0x${string}`)) {
          res.status(401).json({ error: "only post creator can force update" });
          return;
        }

        // check if user has enough credits
        if (!await canUpdate(data.creator, data.template)) {
          res.status(403).json({
            error: `creator (${data.creator}) not enough credits to generate preview for post: ${postId} (${data.template})`
          });
          return;
        }

        console.log(`adding post to queue: ${postId}`);
        this.tasks.add(postId, () => this.handlePostUpdate(postId, forceUpdate));

        res.status(200).json({ status: "processing" });
      }
    );

    /**
     * POST /post/:postId/disable
     * Allows a creator to disable their smart media post
     *
     * @requires verifyLensId middleware
     * @param {string} postId - Lens post ID
     * @returns {Object} Processing status
     * @throws {404} If post not found
     */
    this.app.post(
      "/post/:postId/disable",
      verifyLensId,
      async (req: express.Request, res: express.Response) => {
        const { postId } = req.params;

        const data = await this.getPost(postId as string);
        if (!data) {
          res.status(404).send();
          return;
        }

        if (data.creator !== req.user?.sub as `0x${string}`) {
          res.status(401).json({ error: "only post creator can disable" });
          return;
        }

        elizaLogger.log(`freezing post: ${postId}`);
        // freeze the post to disable updates; remove from cache
        await this.mongo.media?.updateOne({ postId }, { $set: { status: SmartMediaStatus.DISABLED } });
        await this.removePostFromCache(data);

        res.status(200).json();
      }
    );

    /**
     * GET /post/:postId/canvas
     * Returns the HTML Canvas (if any)  for a given postId
     *
     * @param {string} postId - Lens post ID
     * @returns {Object} HTML canvas
     */
    this.app.get(
      "/post/:postId/canvas",
      async (req: express.Request, res: express.Response) => {
        const { postId } = req.params;

        const post = await this.getPost(postId as string);
        const canvasHtml = post?.canvas;

        if (!canvasHtml) {
          res.status(404).send();
          return;
        }

        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(canvasHtml);
      }
    );

    // Serve static images from temp directory
    this.app.use('/images', express.static(path.join(process.cwd(), 'temp', 'images'), {
      setHeaders: (res) => {
        res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      }
    }));
  }

  /**
   * Handles the update process for a smart media post.
   * Generates new content, updates metadata, and refreshes the Lens post.
   * If a post is not updated after enough checks, we freeze it to avoid future checks from the cron job
   *
   * @param {string} postId - Lens post ID
   * @param {boolean} forceUpdate - If the update should be forced
   * @returns {Promise<void>}
   */
  private async handlePostUpdate(postId: string, forceUpdate?: boolean): Promise<void> {
    console.log(`handlePostUpdate: ${postId}, forceUpdate => ${forceUpdate || false}`);
    const data = await this.getPost(postId as string);
    if (!data) {
      console.log("no data found");
      return;
    }

    const runtime = this.agents.get(process.env.GLOBAL_AGENT_ID as UUID);
    const template = this.templates.get(data.template);

    if (!template) {
      elizaLogger.error("Template not registered");
      return;
    }

    // check if the post has been deleted
    const post = await fetchPostById(postId);
    if (post?.isDeleted) {
      elizaLogger.log(`post is deleted, freezing post: ${postId}`);
      await this.mongo.media?.updateOne({ postId }, { $set: { status: SmartMediaStatus.DISABLED } });
      await this.removePostFromCache(data);
      return;
    }

    // check if user has enough credits
    if (!await canUpdate(data.creator, data.template)) {
      elizaLogger.error(`not enough credits for post: ${postId}`);
      return;
    }

    // generate the next version of the post metadata
    elizaLogger.info(`invoking ${data.template} handler for post: ${postId}`);
    const response = await template?.handler(runtime as IAgentRuntime, data, undefined, { forceUpdate });

    // no response means template failed
    if (!response) {
      elizaLogger.error(`handler failed, no response for post: ${postId}`);

      // freeze the post to skip future checks; remove from cache
      if ((Math.floor(Date.now() / 1000)) - data.updatedAt > DEFAULT_FREEZE_TIME) {
        elizaLogger.log(`freezing post: ${postId}`);
        await this.mongo.media?.updateOne({ postId }, { $set: { status: SmartMediaStatus.FAILED } });
        await this.removePostFromCache(data);
      }
      return;
    } else if (!response.refreshMetadata && response.totalUsage.promptTokens === 0 && response.totalUsage.imagesCreated === 0 && response.totalUsage.videosCreated === 0) {
      elizaLogger.error(`no updates for post: ${postId}`);
      // freeze the post to skip future checks; remove from cache
      if ((Math.floor(Date.now() / 1000)) - data.updatedAt > DEFAULT_FREEZE_TIME) {
        elizaLogger.log(`freezing post: ${postId}`);
        await this.mongo.media?.updateOne({ postId }, { $set: { status: SmartMediaStatus.FAILED } });
        await this.removePostFromCache(data);
      }
      return;
    }
    elizaLogger.info(`handler completed for post: ${postId}`);

    const needsStatusUpdate = data.status === SmartMediaStatus.DISABLED || data.status === SmartMediaStatus.FAILED;
    const hasNewVersion = !!response.persistVersionUri;

    // Update database if we need to update status or have a new version
    if (needsStatusUpdate || hasNewVersion) {
      const update: any = {};
      if (hasNewVersion) {
        update.$push = { versions: response.persistVersionUri as string };
        update.$set = { versionCount: (data.versionCount || 0) + 1 };
      }
      if (needsStatusUpdate) {
        update.$set = { status: SmartMediaStatus.ACTIVE };
      }
      elizaLogger.log(`updating db record for post: ${postId}`);
      await this.mongo.media?.updateOne({ postId }, update);
    }

    // decrement user credits
    const totalUsage = response?.totalUsage;
    await decrementCredits(
      data.creator,
      template?.clientMetadata.defaultModel || DEFAULT_MODEL_ID,
      { input: totalUsage?.promptTokens || 0, output: totalUsage?.completionTokens || 0 },
      totalUsage?.imagesCreated || 0,
      totalUsage?.videoCostParams,
      totalUsage?.audioCharacters,
      totalUsage?.customTokens
    );

    // no metadata and no refreshCache flag means nothing to update on the post
    if (!(response?.metadata || response?.refreshMetadata) && !response?.refreshCache) {
      elizaLogger.log(`no metadata, skipping update for post: ${postId}`);
      return;
    }

    // refresh the post metadata
    if (response.metadata || response?.refreshMetadata) {
      const jobId = await refreshMetadataFor(postId);
      const status = await refreshMetadataStatusFor(jobId as string);
      elizaLogger.info(`submitted lens refresh metadata request for post: ${postId} (${jobId} => ${status})`);
      if (status === "FAILED") {
        elizaLogger.error("Failed to refresh post metadata");
        await this.mongo.media?.updateOne({ postId }, { $set: { status: SmartMediaStatus.FAILED } });
        return;
      }
    }

    // update the cache with the latest template data needed for next generation (if any)
    await this.cachePost({
      ...data,
      templateData: response.updatedTemplateData || data.templateData,
      updatedAt: Math.floor(Date.now() / 1000),
      // HACK: make sure we dont save these in redis
      versions: undefined,
      versionCount: (data.versionCount || 0) + 1,
      status: undefined,
    });

    elizaLogger.info(`done updating post: ${postId}`);
  }

  /**
   * Handles credit management for preview generation.
   *
   * For non-premium templates, it implements a rate limiting system that allows
   * a certain number of free previews per hour. For premium templates or when
   * the free preview limit is exceeded, it decrements the user's credits.
   *
   * @param {TemplateName} templateName - The name of the template being used
   * @param {string} creator - The creator's address (0x...)
   * @param {TemplateUsage} totalUsage - Usage metrics including tokens and media created
   * @param {string} [defaultModel] - Optional default model ID to use for credit calculation
   *
   * @returns {Promise<void>}
   */
  private async handlePreviewCredits(templateName: TemplateName, creator: string, totalUsage: TemplateUsage, defaultModel?: string) {
    // Check preview rate limit (for non-premium templates)
    if (!PREMIUM_TEMPLATES.includes(templateName)) {
      const previewKey = `create_preview_count:${creator}`;
      const previewCount = await this.redis.get(previewKey);

      // Update free credit counter for the hour
      if (previewCount && Number.parseInt(previewCount) < FREE_GENERATIONS_PER_HOUR) {
        const multi = this.redis.multi();
        multi.incr(previewKey);
        multi.expire(previewKey, 3600); // 1 hour in seconds
        await multi.exec();

        return;
      }
    }

    // decrement user credits
    await decrementCredits(
      creator,
      defaultModel || DEFAULT_MODEL_ID,
      { input: totalUsage?.promptTokens || 0, output: totalUsage?.completionTokens || 0 },
      totalUsage?.imagesCreated || 0,
      totalUsage?.videoCostParams,
      totalUsage?.audioCharacters,
      totalUsage?.customTokens,
    );
  }

  /**
   * Initializes MongoDB connection and registers available templates.
   */
  private async initialize() {
    await initCollections();
    this.mongo = await getClient();

    // init templates
    // for (const template of [adventureTimeTemplate, adventureTimeVideo, evolvingArtTemplate, infoAgentTemplate]) {
    for (const template of [bonsaiGardenTemplate]) {
      this.templates.set(template.clientMetadata.name, template);
    };
  }

  /**
   * Registers an agent runtime for template processing.
   *
   * @param {IAgentRuntime} runtime - Agent runtime to register
   */
  public registerAgent(runtime: IAgentRuntime) {
    this.agents.set(runtime.agentId, runtime);
  }

  /**
   * Caches a preview of smart media before post creation.
   *
   * @param {SmartMediaBase} data - Preview data to cache
   */
  public cachePreview(data: SmartMediaBase) {
    this.cache.set(data.agentId, data);
  }

  /**
   * Removes a preview from the cache.
   *
   * @param {UUID} agentId - ID of preview to delete
   */
  public deletePreview(agentId: UUID) {
    this.cache.delete(agentId);
  }

  /**
   * Caches post data in Redis.
   *
   * @param {SmartMedia} data - Post data to cache
   */
  public async cachePost(data: SmartMedia) {
    await this.redis.set(`post/${data.postId}`, JSON.stringify(data));
  }

  /**
   * Caches post data in Redis.
   *
   * @param {SmartMedia} data - Post data to cache
   */
  public async removePostFromCache(data: SmartMedia) {
    await this.redis.del(`post/${data.postId}`);
  }

  /**
   * Retrieves post data from Redis or MongoDB.
   *
   * @param {string} postId - Lens post ID
   * @returns {Promise<SmartMedia | null>} Post data or null if not found
   */
  public async getPost(postId: string): Promise<SmartMedia | null> {
    const res = await this.redis.get(`post/${postId}`);

    if (!res) {
      const doc = await this.mongo.media?.findOne(
        { postId },
        {
          projection: {
            _id: 0,
            versions: { $slice: -10 } // only last 10 versions
          }
        }
      );
      return doc as unknown as SmartMedia;
    }

    return JSON.parse(res);
  }

  /**
   * Starts the Express server on the specified port.
   *
   * @param {number} port - Port number to listen on
   */
  public start(port: number) {
    this.server.listen(port, () => {
      console.log(
        `BonsaiClient server running on http://localhost:${port}/`
      );
    });
  }
}

export class BonsaiClientService extends Service {
  static serviceType = ServiceType.NKN_CLIENT_SERVICE;
  static async initialize() { }

  capabilityDescription = 'Implements the Smart Media Protocol';

  constructor(protected runtime: IAgentRuntime) {
    super();
  }

  async initialize(): Promise<void> { }

  static async start(runtime: IAgentRuntime): Promise<BonsaiClientService> {
    console.log("BonsaiClientService:: start");
    const service = new BonsaiClientService(runtime);
    const client = new BonsaiClient();

    client.registerAgent(runtime);
    client.start(Number.parseInt(settings.BONSAI_SMP_PORT || "3001"));

    return service;
  }

  async stop(): Promise<void> {
    console.log("BonsaiClientService:: stop");
  }

  async sendMessage(content: string, channelId: string): Promise<void> { }
};