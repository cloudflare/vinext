"use client";

// antd is on vinext's default optimizePackageImports list.
import { Button } from "antd";
import * as antd from "antd";
import { ReexportedButton } from "./ui";

export function DefaultBarrelClient() {
  return (
    <main>
      <Button id="named" />
      <antd.Button id="namespace" />
      <ReexportedButton id="reexport" />
    </main>
  );
}
