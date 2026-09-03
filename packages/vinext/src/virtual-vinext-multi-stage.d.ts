declare module "virtual:vinext-request-stage" {
  export const handleRequestStage: import("./server/multi-stage.js").VinextRequestStageHandler;
}

declare module "virtual:vinext-response-stage" {
  export const handleResponseStage: import("./server/multi-stage.js").VinextResponseStageHandler;
}
