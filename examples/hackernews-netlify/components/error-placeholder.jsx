import { useEffect } from "react";

export default function ErrorPlaceholder({ error }) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error(error);
  }, [error]);

  return (
    <span>{`Application error: a server-side exception has occurred`}</span>
  );
}
