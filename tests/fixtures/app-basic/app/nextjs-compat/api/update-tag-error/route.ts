import { updateTag } from "next/cache";
import { NextResponse } from "next/server";

export function GET() {
  try {
    updateTag("test-tag");
    return NextResponse.json({ error: "Should not reach here" });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}
