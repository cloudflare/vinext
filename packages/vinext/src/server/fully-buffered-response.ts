type ResponseWithFullyBufferedBodyMetadata = Response & {
  __vinextFullyBufferedBody?: boolean;
};

/**
 * Mark a response whose body vinext constructed from a fully in-memory string
 * or byte array, as opposed to a body handed back by user code, which could
 * still be producing. With no producer left, no `after()` call can originate
 * from this body.
 */
export function markFullyBufferedBody(response: Response): Response {
  (response as ResponseWithFullyBufferedBodyMetadata).__vinextFullyBufferedBody = true;
  return response;
}

export function isFullyBufferedBody(response: Response): boolean {
  return (response as ResponseWithFullyBufferedBodyMetadata).__vinextFullyBufferedBody === true;
}

export function preserveFullyBufferedBodyMetadata(source: Response, target: Response): Response {
  return isFullyBufferedBody(source) ? markFullyBufferedBody(target) : target;
}
