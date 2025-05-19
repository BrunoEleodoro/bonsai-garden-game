"use client";

import { useState } from "react";
import { ConnectKitButton } from "connectkit";
import { Web3Provider } from "@/components/Web3Provider";
import { PingButton } from "@/components/ui/ping-button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function Page() {
  const [, setTxHash] = useState<string | null>(null);

  const handleTransactionConfirmed = (hash: string) => {
    setTxHash(hash);
  };

  return (
    <Web3Provider>
      <div className="flex min-h-screen flex-row items-stretch justify-center p-4 bg-background text-foreground gap-4">
        {/* Left Panel: Players Connected */}
        <div className="w-64 flex flex-col">
          <Card className="flex-1">
            <CardHeader>
              <CardTitle>Players Connected</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Placeholder for player list */}
              <ul className="space-y-2">
                <li>Player 1</li>
                <li>Player 2</li>
                <li>Player 3</li>
              </ul>
            </CardContent>
          </Card>
        </div>
        {/* Center: Game Iframe */}
        <div className="flex-1 flex flex-col items-center justify-center">
          <iframe
            src="https://bonsai-garden-game-production.up.railway.app/"
            title="Bonsai Garden Game"
            className="rounded-xl border shadow w-full max-w-3xl aspect-video min-h-[500px] bg-black"
            allowFullScreen
          />
        </div>
        {/* Right Panel: Chat */}
        <div className="w-80 flex flex-col">
          <Card className="flex-1 flex flex-col">
            <CardHeader>
              <CardTitle>Chat</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col gap-4">
              {/* Lens Auth (ConnectKitButton) */}
              <div>
                <ConnectKitButton />
              </div>
              {/* Placeholder for chat messages */}
              <div className="flex-1 bg-muted rounded p-2 mb-2 overflow-y-auto text-sm text-muted-foreground">
                <div>Chat coming soon...</div>
              </div>
              {/* Placeholder for chat input */}
              <input
                type="text"
                className="w-full border rounded p-2 text-foreground bg-background"
                placeholder="Type a message... (coming soon)"
                disabled
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </Web3Provider>
  );
}
