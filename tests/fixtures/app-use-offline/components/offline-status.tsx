"use client";
import { useOffline } from "next/offline";

export function OfflineStatus() {
  const isOffline = useOffline();
  return <div className="offline-status">{isOffline ? "offline" : "online"}</div>;
}
