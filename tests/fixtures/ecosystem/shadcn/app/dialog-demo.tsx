"use client";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";

export function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="dialog-trigger">
          Open Dialog
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle data-testid="dialog-title">Test Dialog</DialogTitle>
          <DialogDescription data-testid="dialog-description">
            This is a test dialog using Radix UI primitives via ShadCN.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
