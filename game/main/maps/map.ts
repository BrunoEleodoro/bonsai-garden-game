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
    const users = await fetch("https://jsonplaceholder.typicode.com/users");
    const usersData = await users.json();

    const graphics = ["hero", "hero", "female", "male"];

    // Helper to get a message from OpenRouter (using OpenAI lib)
    async function getOpenRouterMessage() {
      try {
        console.log("Fetching OpenRouter message via OpenAI lib...");
        const chatCompletion = await openai.chat.completions.create({
          model: "meta-llama/llama-3.3-8b-instruct:free",
          messages: [
            {
              role: "user",
              content:
                "You are a friendly NPC in a fantasy RPG town. Say something short and interesting to a passing player. 30 characters max. output in JSON format: { \"message\": \"Hello, traveler!\" }",
            },
          ],
        });

        // Extract the message content
        const content =
          chatCompletion.choices?.[0]?.message?.content?.trim() ||
          "Hello, traveler!";
        console.log('received message')
        return content;
      } catch (e) {
        console.error("Failed to fetch OpenRouter message:", e);
        return "Hello, traveler!";
      }
    }

    // Store references to events for batch updates
    const npcEvents = usersData.slice(0, 4).map((user) => {
      const eventObj = this.createDynamicEvent({
        x: Math.floor(Math.random() * 350),
        y: Math.floor(Math.random() * 350),
        event: Villager2Event,
      });
      const event = Object.values(eventObj)[0];
      event.setComponentsTop(Components.text(user.name));
      event.setGraphic(
        graphics[Math.floor(Math.random() * graphics.length)]
      );
      return { event, user };
    });

    // Helper to update all NPCs in a batch, waiting for all to finish before next batch
    const updateAllPhrases = async () => {
      // For each NPC, fetch a new phrase and update
      await Promise.all(
        npcEvents.map(async ({ event, user }) => {
          const phrase = await getOpenRouterMessage();
          let parsedPhrase;
          try {
            parsedPhrase = JSON.parse(phrase);
          } catch (e) {
            // fallback if not valid JSON
            parsedPhrase = { message: phrase };
          }
          console.log(parsedPhrase)
          event.setComponentsTop([
            // Components.text(user.name),
            Components.text(parsedPhrase.message),
          ]);
        })
      );
    };

    // Start the batch update loop
    const BATCH_INTERVAL = 35000; // 35 seconds, slightly longer than before to allow all requests to finish

    // Initial phrase update for all NPCs
    updateAllPhrases();

    // Batch loop: only start next batch after all NPCs have finished updating
    const batchLoop = async () => {
      while (true) {
        await updateAllPhrases();
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
