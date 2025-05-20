import { Components, RpgPlayer } from "@rpgjs/server";
import { MapData, RpgMap } from "@rpgjs/server";
import Villager2Event from "../events/villager2";
import dotenv from 'dotenv';
dotenv.config({});

// Import OpenAI library
import OpenAI from "openai";

@MapData({
  id: "map",
  file: require("./map.tmx"),
})

export default class TownMap extends RpgMap {
  async onInit() {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const SITE_URL = "https://yourdomain.com"; // Replace with your site URL
    const SITE_NAME = "Bonsai Game"; // Replace with your site name

    // Set up OpenAI client for OpenRouter
    const openai = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": SITE_URL,
        "X-Title": SITE_NAME,
      },
      dangerouslyAllowBrowser: true, // in case this is ever run in browser context
    });

    console.log("Map loaded");
    const apiEndpoint = "https://content-luck-production.up.railway.app/rpg-heroes";

    // Helper to get a message from OpenRouter (using OpenAI lib)
    async function getOpenRouterMessage(personality: string, action: string) {
      try {
        const prompt = `
          You are a friendly NPC in a fantasy RPG town.\nYour personality is: ${personality}.\nYou are currently: ${action}.\nSay something short and interesting to a passing player. 30 characters max.\nOutput in JSON format: { \"message\": \"Hello, traveler!\" }`
        const chatCompletion = await openai.chat.completions.create({
          model: "meta-llama/llama-3.3-8b-instruct:free",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        });
        const content =
          chatCompletion.choices?.[0]?.message?.content?.trim() ||
          "Hello, traveler!";
        return content;
      } catch (e) {
        console.error("Failed to fetch OpenRouter message:", e);
        return "Hello, traveler!";
      }
    }

    // Store references to events for batch updates
    let npcEvents: Array<{ event: any, hero: any }> = [];

    // Helper to check if an NPC with the same unique id (or personality+action) already exists
    function isNpcAlreadyPresent(hero: any) {
      // You can use a unique id if available, or fallback to personality+action
      return npcEvents.some(({ hero: existingHero }) => {
        if (hero.id && existingHero.id) {
          return hero.id === existingHero.id;
        }
        // fallback: compare personality+action
        return (
          hero.templateData?.personality === existingHero.templateData?.personality &&
          hero.templateData?.action === existingHero.templateData?.action
        );
      });
    }

    // Helper to create new NPCs, avoiding duplicates
    const createNPCs = (heroesData: any[]) => {
      // Remove old NPCs from the map
      for (const { event } of npcEvents) {
        if (event && typeof event.destroy === "function") {
          event.destroy();
        }
      }
      npcEvents = [];

      // Track which NPCs have already been added (by id or personality+action)
      const addedNpcKeys = new Set();

      for (const hero of heroesData) {
        // Build a unique key for the hero (prefer id, else personality+action)
        let key = hero.id
          ? `id:${hero.id}`
          : `p:${hero.templateData?.personality || ""}|a:${hero.templateData?.action || ""}`;
        if (addedNpcKeys.has(key)) {
          continue; // skip duplicate
        }
        addedNpcKeys.add(key);

        // Check if already present in the game (shouldn't be, since we destroy all above, but for safety)
        if (isNpcAlreadyPresent(hero)) {
          continue;
        }

        // Limit to 4 NPCs
        if (npcEvents.length >= 4) break;

        const eventObj = this.createDynamicEvent({
          x: Math.floor(Math.random() * 350),
          y: Math.floor(Math.random() * 350),
          event: Villager2Event,
        });
        const event = Object.values(eventObj)[0];
        event.setComponentsTop([
          Components.text(hero.templateData?.personality || "Unknown Hero"),
        ]);
        event.setGraphic("hero");
        npcEvents.push({ event, hero });
      }
    };

    // Helper to update all NPCs in a batch, waiting for all to finish before next batch
    const updateAllPhrases = async () => {
      await Promise.all(
        npcEvents.map(async ({ event, hero }) => {
          const phrase = await getOpenRouterMessage(
            hero.templateData?.personality || "brave",
            hero.templateData?.action || "standing heroically"
          );
          let parsedPhrase;
          try {
            parsedPhrase = JSON.parse(phrase);
          } catch (e) {
            parsedPhrase = { message: phrase };
          }
          event.setComponentsTop([
            Components.text(parsedPhrase.message),
          ]);
        })
      );
    };

    // Fetch and create initial NPCs
    const fetchAndCreateNPCs = async () => {
      try {
        const response = await fetch(apiEndpoint);
        const heroesData = await response.json();

        // Filter out heroes that are already present (by id or personality+action)
        const uniqueHeroes = [];
        const seenKeys = new Set();
        for (const hero of heroesData) {
          let key = hero.id
            ? `id:${hero.id}`
            : `p:${hero.templateData?.personality || ""}|a:${hero.templateData?.action || ""}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            uniqueHeroes.push(hero);
          }
        }

        createNPCs(uniqueHeroes);
        await updateAllPhrases();
      } catch (e) {
        console.error("Failed to fetch or create NPCs:", e);
      }
    };

    // Start the batch update loop
    const BATCH_INTERVAL = 35000; // 35 seconds, slightly longer than before to allow all requests to finish
    const NPC_REFRESH_INTERVAL = 120000; // 2 minutes: how often to fetch new NPCs

    // Initial fetch and create
    await fetchAndCreateNPCs();

    // Batch loop: only start next batch after all NPCs have finished updating
    let lastNpcRefresh = Date.now();
    const batchLoop = async () => {
      while (true) {
        // If it's time to refresh NPCs, fetch new ones and update
        if (Date.now() - lastNpcRefresh > NPC_REFRESH_INTERVAL) {
          await fetchAndCreateNPCs();
          lastNpcRefresh = Date.now();
        } else {
          await updateAllPhrases();
        }
        await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL));
      }
    };
    batchLoop();

    // Optionally, store a reference to batchLoop for cleanup if needed
  }

  onJoin(player: RpgPlayer) {
    console.log("enter", player.id);
  }

  // When the player leaves the map
  onLeave(player: RpgPlayer) {
    super.onLeave(player);
    console.log("leave", player.id);
  }
}
