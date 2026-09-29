// Route graph IDs shared by the build-time scanner and the RSC runtime. Kept in
// a leaf module so runtime imports don't pull the scanner into the RSC graph.

export function createAppRouteGraphInterceptionId(
  slotId: string,
  sourcePattern: string,
  targetPattern: string,
): string {
  return `interception:${slotId}:${sourcePattern}->${targetPattern}`;
}
