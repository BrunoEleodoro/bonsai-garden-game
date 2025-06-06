import type { Plugin } from "@elizaos/core";
import { BonsaiClientService } from "./ClientService";

const bonsai: Plugin = {
    name: 'Bonsai Client',
    description: 'The Bonsai Client is an implementation of the Smart Media Protocol (SMP) that brings agentic content to the Lens feed.',
    clients: [BonsaiClientService],
    actions: [],
    providers: [],
};

export default bonsai;

export type {
    CreateTemplateRequestParams,
    LaunchpadToken,
    SmartMedia,
    SmartMediaBase,
    Template,
    TemplateUsage,
    TemplateHandler,
    TemplateHandlerResponse,
    TemplateClientMetadata,
} from "./utils/types";