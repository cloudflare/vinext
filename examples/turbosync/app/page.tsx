"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Video,
  Zap,
  Lock,
  ChevronRight,
  Activity,
  MonitorPlay,
} from "lucide-react";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white/20">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black/50 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video size={20} className="text-white" />
            TurboSync
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/room"
              className="text-sm text-[#A1A1AA] hover:text-white transition-colors font-medium"
            >
              Join Room
            </Link>
            <Link href="/room">
              <span className="inline-flex h-9 items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-gray-200">
                Start Syncing
              </span>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="pt-32 pb-16 px-6 relative overflow-hidden">
        {/* Glow effect */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] bg-white/5 rounded-full blur-[120px] pointer-events-none" />

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-[#A1A1AA] font-medium mb-8">
            <Activity size={14} className="text-green-400" />
            <span className="opacity-80">Real-time local playback</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter mb-6 bg-clip-text text-transparent bg-gradient-to-br from-white via-white to-gray-500">
            Watch together.
            <br />
            Without the buffer.
          </h1>

          <p className="text-lg md:text-xl text-[#A1A1AA] mb-10 max-w-2xl mx-auto font-medium tracking-tight">
            TurboSync uses WebSockets to perfectly synchronize local video files
            across multiple devices. No streaming servers. No latency. Crystal
            clear native quality.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/room">
              <Button
                size="lg"
                className="h-12 px-8 rounded-full bg-white text-black hover:bg-gray-200 text-base font-semibold"
              >
                Create a Room
                <ChevronRight size={16} className="ml-1 opacity-50" />
              </Button>
            </Link>
            <Link href="/room">
              <Button
                size="lg"
                variant="outline"
                className="h-12 px-8 rounded-full border-white/10 bg-white/5 text-white hover:bg-white/10 text-base font-semibold"
              >
                Join existing
              </Button>
            </Link>
          </div>
        </div>

        {/* Feature Grid */}
        <div className="max-w-6xl mx-auto mt-32 grid md:grid-cols-3 gap-6">
          <FeatureCard
            icon={<Zap size={24} className="text-white" />}
            title="Zero Latency"
            description="Videos remain on your local disk. We only sync the play/pause actions and timestamps via ultra-fast WebSockets."
          />
          <FeatureCard
            icon={<MonitorPlay size={24} className="text-white" />}
            title="Native Quality"
            description="Say goodbye to blocky screen sharing. Watch your 4K HDR files in pristine native quality with 0 drop in bitrate."
          />
          <FeatureCard
            icon={<Lock size={24} className="text-white" />}
            title="Secure & Private"
            description="Your media files never touch our servers. Room metadata is ephemeral, fast and securely authenticated."
          />
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 mt-20">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between text-sm text-[#A1A1AA] font-medium">
          <div className="flex items-center gap-2">
            <Video size={16} />
            TurboSync
          </div>
          <p className="mt-4 md:mt-0">
            © {new Date().getFullYear()} TurboSync. Built for synchronous play.
          </p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-8 hover:bg-white/[0.07] transition-colors">
      <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center mb-6 border border-white/5">
        {icon}
      </div>
      <h3 className="text-xl font-bold mb-3 text-white tracking-tight">
        {title}
      </h3>
      <p className="text-[#A1A1AA] leading-relaxed font-medium">
        {description}
      </p>
    </div>
  );
}
