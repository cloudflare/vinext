/**
 * Fix invalid preload "as" values in RSC Flight hint lines before they reach
 * the client. React Flight emits HL hints with as="stylesheet" for CSS, but
 * the HTML spec requires as="style" for <link rel="preload">.
 */
export function fixFlightHints(text: string): string {
  return text.replace(/(\d*:HL\[.*?),"stylesheet"(\]|,)/g, '$1,"style"$2');
}

function isPotentialHintPrefix(value: string): boolean {
  return /^\d*(?::(?:H(?:L(?:\[)?)?)?)?$/.test(value);
}

function isCompleteHintPrefix(value: string): boolean {
  return /^\d*:HL\[$/.test(value);
}

/**
 * Streaming version of fixFlightHints().
 *
 * Flight records are newline-delimited, but buffering an entire partial line
 * can block the App Router shell when workerd splits an early model row before
 * its trailing newline. This parser only buffers the tiny line prefix needed to
 * identify HL records, plus the `,"stylesheet"` token when it is split across
 * chunks.
 */
export function createFlightHintFixTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const token = ',"stylesheet"';
  const replacement = ',"style"';
  let mode: "prefix" | "hint" | "passthrough" = "prefix";
  let prefix = "";
  let tokenMatch = "";

  function processText(text: string): string {
    let output = "";

    const emit = (value: string): void => {
      output += value;
    };

    const processHintChar = (char: string): void => {
      if (char === "\n") {
        emit(tokenMatch);
        tokenMatch = "";
        emit(char);
        mode = "prefix";
        return;
      }

      const nextMatch = tokenMatch + char;
      if (token.startsWith(nextMatch)) {
        tokenMatch = nextMatch;
        return;
      }

      if (tokenMatch === token && (char === "]" || char === ",")) {
        emit(replacement);
        tokenMatch = "";
        emit(char);
        return;
      }

      if (tokenMatch) {
        emit(tokenMatch);
        tokenMatch = "";
        processHintChar(char);
        return;
      }

      emit(char);
    };

    for (const char of text) {
      if (mode === "prefix") {
        prefix += char;

        if (char === "\n") {
          emit(prefix);
          prefix = "";
          continue;
        }

        if (isCompleteHintPrefix(prefix)) {
          emit(prefix);
          prefix = "";
          mode = "hint";
          continue;
        }

        if (isPotentialHintPrefix(prefix)) {
          continue;
        }

        emit(prefix);
        prefix = "";
        mode = "passthrough";
        continue;
      }

      if (mode === "hint") {
        processHintChar(char);
        continue;
      }

      emit(char);
      if (char === "\n") {
        mode = "prefix";
      }
    }

    return output;
  }

  function flushCarry(): string {
    let output = prefix;
    prefix = "";
    output += tokenMatch;
    tokenMatch = "";
    return output;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = processText(decoder.decode(chunk, { stream: true }));
      if (output) controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const output = processText(decoder.decode()) + flushCarry();
      if (output) controller.enqueue(encoder.encode(output));
    },
  });
}
