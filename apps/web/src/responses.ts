interface ResponseOrder {
  readonly send: () => number;
  readonly accept: (request: number) => boolean;
  readonly drop: () => void;
}

// Numbers requests so a response is shown only if no later request's response
// has been shown already, and responses to dropped requests never are.
export function responseOrder(): ResponseOrder {
  let sent = 0;
  let shown = 0;

  return {
    send: () => {
      sent += 1;

      return sent;
    },
    accept: (request) => {
      if (request <= shown) {
        return false;
      }

      shown = request;

      return true;
    },
    drop: () => {
      shown = sent;
    },
  };
}
