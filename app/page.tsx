"use client";

import { useState } from "react";
import { ConnectKitButton } from "connectkit";
import { Web3Provider } from "@/components/Web3Provider";
import { PingButton } from "@/components/PingButton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function Page() {
  const [, setTxHash] = useState<string | null>(null);

  const handleTransactionConfirmed = (hash: string) => {
    setTxHash(hash);
  };

  return (
    <Web3Provider>
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-green-950 via-green-900 to-gray-900 text-foreground">
        {/* RPG Fantasy Header */}
        <header className="w-full py-8 flex flex-col items-center justify-center bg-gradient-to-r from-green-900/80 to-gray-900/80 shadow-lg border-b border-green-800 relative z-10">
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-widest text-green-200 drop-shadow-lg font-serif mb-2 animate-pulse">
            Bonsai Garden RPG
          </h1>
          <p className="text-green-300 text-lg italic opacity-80">
            Enter the lush, mysterious world of the Bonsai Garden
          </p>
        </header>
        {/* Main Content */}
        <main className="flex-1 flex flex-row items-stretch justify-center gap-8 px-4 py-8 max-w-7xl mx-auto w-full">
          {/* Left Panel: Players Connected */}
          <aside className="w-64 flex flex-col">
            <Card className="flex-1 bg-gradient-to-br from-green-950/80 to-gray-900/80 border-green-800 shadow-xl">
              <CardHeader>
                <CardTitle className="text-green-300 font-bold tracking-wide text-xl flex items-center gap-2">
                  <span className="inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  Players Connected
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-green-200 font-mono">
                  <li className="flex items-center gap-2"><span className="w-2 h-2 bg-green-500 rounded-full" />Player 1</li>
                  <li className="flex items-center gap-2"><span className="w-2 h-2 bg-green-500 rounded-full" />Player 2</li>
                  <li className="flex items-center gap-2"><span className="w-2 h-2 bg-green-500 rounded-full" />Player 3</li>
                </ul>
              </CardContent>
            </Card>
          </aside>
          {/* Center: Game Iframe with RPG Frame */}
          <section className="flex-1 flex flex-col items-center justify-center relative">
            <div className="relative w-full max-w-3xl aspect-video min-h-[500px] flex items-center justify-center">
              <div className="absolute inset-0 rounded-3xl border-4 border-green-800 shadow-2xl pointer-events-none z-10 animate-glow" style={{boxShadow: '0 0 40px 10px #14532d55, 0 0 0 4px #166534'}}></div>
              <iframe
                src="https://bonsai-garden-game-production.up.railway.app/"
                title="Bonsai Garden Game"
                className="rounded-2xl border-2 border-green-900 shadow-2xl w-full h-full bg-black"
                allowFullScreen
              />
            </div>
          </section>
          {/* Right Panel: Chat */}
          <aside className="w-80 flex flex-col">
            <Card className="flex-1 flex flex-col bg-gradient-to-br from-gray-900/80 to-green-950/80 border-green-800 shadow-xl">
              <CardHeader>
                <CardTitle className="text-green-300 font-bold tracking-wide text-xl flex items-center gap-2">
                  <span className="inline-block w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  Chat
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-4">
                <div>
                  <ConnectKitButton />
                </div>
                <div className="flex-1 bg-muted/60 rounded p-2 mb-2 overflow-y-auto text-sm text-green-200 font-mono border border-green-900 shadow-inner">
                  <div>Chat coming soon...</div>
                </div>
                <input
                  type="text"
                  className="w-full border border-green-900 rounded p-2 text-foreground bg-background/80 placeholder:text-green-400/60"
                  placeholder="Type a message... (coming soon)"
                  disabled
                />
              </CardContent>
            </Card>
          </aside>
        </main>
        {/* Mystical RPG Footer */}
        <footer className="w-full py-4 flex items-center justify-center bg-gradient-to-r from-green-900/80 to-gray-900/80 border-t border-green-800 text-green-300 text-sm font-mono tracking-wide shadow-inner">
          <span className="opacity-80">&copy; {new Date().getFullYear()} Bonsai Garden RPG &mdash; Cultivate your legend.</span>
        </footer>
      </div>
    </Web3Provider>
  );
}
