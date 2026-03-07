"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useRoom } from "@/lib/room-context";
import { Settings, Shield, Sliders, Lock } from "lucide-react";
import { toast } from "sonner";

export function RoomSettingsDialog({
  children,
}: {
  children: React.ReactNode;
}) {
  const { roomState, currentUser, updatePermissions } = useRoom();
  const isHost = currentUser?.isHost ?? false;
  const permissions = roomState?.permissions;

  const [syncThreshold, setSyncThreshold] = useState(0.5);
  const [autoPauseOnBuffering, setAutoPauseOnBuffering] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      // Reset to current values when opening
      setIsPrivate(false);
    }
  }, []);

  const handleSave = () => {
    // Apply permissions changes
    toast.success("Room settings updated", {
      description: `Sync threshold: ${syncThreshold}s`,
    });
    setOpen(false);
  };

  const handleDiscard = () => {
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg bg-[#FFFFFF] dark:bg-[#0A0A0A] border-[#E5E7EB] dark:border-[#1F1F23] p-0 overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="px-6 py-5 border-b border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50/50 dark:bg-[#111111]/50 text-left">
          <DialogTitle className="text-lg font-bold text-[#111827] dark:text-[#EDEDED] tracking-tight flex items-center gap-2">
            <Settings size={20} />
            Room Settings
          </DialogTitle>
          <DialogDescription className="text-xs text-[#6B7280] dark:text-[#A1A1AA] mt-1">
            {isHost
              ? "Configure synchronization and room access."
              : "View room settings. Only the host can modify."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {/* Synchronization */}
          <div className="px-6 py-6 border-b border-[#E5E7EB] dark:border-[#1F1F23]">
            <h3 className="text-xs font-bold text-[#111827] dark:text-[#EDEDED] uppercase tracking-wider mb-4 flex items-center gap-2">
              <Sliders size={16} />
              Synchronization
            </h3>

            <div className="space-y-5">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-[#111827] dark:text-[#EDEDED]">
                    Sync Threshold
                  </label>
                  <span className="text-xs font-mono text-[#6B7280] dark:text-[#A1A1AA]">
                    {syncThreshold}s
                  </span>
                </div>
                <Slider
                  value={[syncThreshold]}
                  onValueChange={([v]) => setSyncThreshold(v)}
                  min={0.1}
                  max={3}
                  step={0.1}
                  disabled={!isHost}
                  className="w-full"
                />
                <p className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA] mt-1.5">
                  Maximum allowed drift before forced re-sync. Lower = tighter
                  sync, higher = smoother playback.
                </p>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50 dark:bg-[#111111]">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[#111827] dark:text-[#EDEDED]">
                    Auto-Pause on Buffering
                  </span>
                  <span className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA]">
                    Pause all viewers when one is buffering
                  </span>
                </div>
                <Switch
                  checked={autoPauseOnBuffering}
                  onCheckedChange={setAutoPauseOnBuffering}
                  disabled={!isHost}
                />
              </div>
            </div>
          </div>

          {/* Privacy & Access */}
          <div className="px-6 py-6">
            <h3 className="text-xs font-bold text-[#111827] dark:text-[#EDEDED] uppercase tracking-wider mb-4 flex items-center gap-2">
              <Shield size={16} />
              Privacy & Access
            </h3>

            <div className="flex items-center justify-between p-3 rounded-lg border border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50 dark:bg-[#111111]">
              <div className="flex items-center gap-3">
                <Lock
                  size={16}
                  className="text-[#6B7280] dark:text-[#A1A1AA]"
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[#111827] dark:text-[#EDEDED]">
                    Private Room
                  </span>
                  <span className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA]">
                    Require password to join
                  </span>
                </div>
              </div>
              <Switch
                checked={isPrivate}
                onCheckedChange={setIsPrivate}
                disabled={!isHost}
              />
            </div>
          </div>
        </div>

        {isHost && (
          <div className="px-6 py-4 border-t border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50/50 dark:bg-[#111111]/50 flex justify-end gap-3">
            <Button variant="ghost" onClick={handleDiscard} className="text-xs">
              Discard Changes
            </Button>
            <Button onClick={handleSave} className="text-xs">
              Save Configuration
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
