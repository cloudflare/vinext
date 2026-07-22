// Tests that params named then, catch, finally, and status work correctly
// in route handlers. The thenable wrapper must protect well-known properties
// so that await still works, while making the actual param values available
// after resolution.
export async function GET(
  request: Request,
  { params }: { params: { then: string; catch: string; finally: string; status: string } },
) {
  const resolved = await params;
  return Response.json({
    then: resolved.then,
    catch: resolved.catch,
    finally: resolved.finally,
    status: resolved.status,
    isThenable: typeof params.then === "function",
  });
}
