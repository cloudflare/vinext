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
import { useRoom } from "@/lib/room-context";
import { Settings2, Users, Ban, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export function PeerPermissionsDialog({
  children,
}: {
  children: React.ReactNode;
}) {
  const { roomState, currentUser, kick, updatePermissions } = useRoom();
  const users = roomState?.users || [];
  const permissions = roomState?.permissions;
  const isHost = currentUser?.isHost ?? false;

  const [chatEnabled, setChatEnabled] = useState(
    permissions?.viewersCanChat ?? true,
  );
  const [controlEnabled, setControlEnabled] = useState(
    permissions?.viewersCanControl ?? true,
  );
  const [open, setOpen] = useState(false);

  // Sync local state when dialog opens
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen);
      if (isOpen && permissions) {
        setChatEnabled(permissions.viewersCanChat);
        setControlEnabled(permissions.viewersCanControl);
      }
    },
    [permissions],
  );

  const handleSave = () => {
    updatePermissions({
      viewersCanChat: chatEnabled,
      viewersCanControl: controlEnabled,
    });
    toast.success("Permissions updated");
    setOpen(false);
  };

  const handleKick = (userId: string, displayName: string) => {
    kick(userId);
    toast.success(`Kicked ${displayName}`);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl bg-[#FFFFFF] dark:bg-[#0A0A0A] border-[#E5E7EB] dark:border-[#1F1F23] p-0 overflow-hidden flex flex-col max-h-[90vh]">
        <DialogHeader className="px-6 py-5 border-b border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50/50 dark:bg-[#111111]/50 text-left">
          <DialogTitle className="text-lg font-bold text-[#111827] dark:text-[#EDEDED] tracking-tight">
            Peer Permissions
          </DialogTitle>
          <DialogDescription className="text-xs text-[#6B7280] dark:text-[#A1A1AA] mt-1">
            {isHost
              ? "Manage access control and participant capabilities."
              : "View current room permissions. Only the host can change settings."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {/* Global Permissions Section */}
          <div className="px-6 py-6 border-b border-[#E5E7EB] dark:border-[#1F1F23]">
            <h3 className="text-xs font-bold text-[#111827] dark:text-[#EDEDED] uppercase tracking-wider mb-4 flex items-center gap-2">
              <Settings2 size={16} />
              Global Permissions
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center justify-between p-3 rounded-lg border border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50 dark:bg-[#111111]">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[#111827] dark:text-[#EDEDED]">
                    Allow Chat
                  </span>
                  <span className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA]">
                    Participants can send messages
                  </span>
                </div>
                <Switch
                  checked={chatEnabled}
                  onCheckedChange={setChatEnabled}
                  disabled={!isHost}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50 dark:bg-[#111111]">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-[#111827] dark:text-[#EDEDED]">
                    Playback Control
                  </span>
                  <span className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA]">
                    Viewers can pause/seek
                  </span>
                </div>
                <Switch
                  checked={controlEnabled}
                  onCheckedChange={setControlEnabled}
                  disabled={!isHost}
                />
              </div>
            </div>
          </div>

          {/* Participants Table */}
          <div className="px-6 py-6">
            <h3 className="text-xs font-bold text-[#111827] dark:text-[#EDEDED] uppercase tracking-wider flex items-center gap-2 mb-4">
              <Users size={16} />
              Participants
              <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 dark:bg-gray-800 text-[#6B7280] border border-[#E5E7EB] dark:border-[#1F1F23]">
                {users.length} Active
              </span>
            </h3>

            <div className="border border-[#E5E7EB] dark:border-[#1F1F23] rounded-lg overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50/50 dark:bg-[#111111]/50 text-[10px] uppercase text-[#6B7280] dark:text-[#A1A1AA] font-bold tracking-widest border-b border-[#E5E7EB] dark:border-[#1F1F23]">
                  <tr>
                    <th className="px-4 py-3 font-semibold">User</th>
                    <th className="px-4 py-3 font-semibold w-32">Role</th>
                    <th className="px-4 py-3 font-semibold text-right w-24">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5E7EB] dark:divide-[#1F1F23] bg-white dark:bg-[#0A0A0A]">
                  {users.map((user) => {
                    const isMe = user.id === currentUser?.id;
                    return (
                      <tr
                        key={user.id}
                        className="group hover:bg-gray-50 dark:hover:bg-[#111111] transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-linear-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-[10px] font-black border border-white/20 shadow-sm">
                              {user.displayName.substring(0, 2).toUpperCase()}
                            </div>
                            <div className="flex flex-col">
                              <span className="font-semibold text-[#111827] dark:text-[#EDEDED] text-sm leading-tight">
                                {user.displayName}
                              </span>
                              <span className="text-[10px] text-[#6B7280] dark:text-[#A1A1AA] leading-tight mt-0.5">
                                user_{user.id?.substring(0, 4)}
                              </span>
                            </div>
                            {isMe && (
                              <Badge
                                variant="outline"
                                className="text-[9px] h-4 px-1.5 py-0 border-blue-500/30 text-blue-500"
                              >
                                You
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${user.isHost ? "border-amber-500/30 text-amber-500" : "border-gray-300 dark:border-gray-700 text-[#6B7280]"}`}
                          >
                            {user.isHost ? "Host" : "Viewer"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isHost && !user.isHost && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                handleKick(user.id, user.displayName)
                              }
                              className="h-7 px-2 text-[#6B7280] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10"
                            >
                              <Ban size={16} />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {isHost && (
          <div className="px-6 py-4 border-t border-[#E5E7EB] dark:border-[#1F1F23] bg-gray-50/50 dark:bg-[#111111]/50 flex justify-end gap-3">
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button onClick={handleSave} className="text-xs">
              Save Changes
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
