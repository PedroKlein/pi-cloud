import type { PageProps, WebPlugin } from "@pipoca/plugins/web";
import { Button, PageTitle } from "@pipoca/ui";
import { useState } from "react";

function Page({ context }: PageProps) {
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const response = await context.request("greeting");
    const body = (await response.json()) as { greeting: string };

    setGreeting(body.greeting);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <PageTitle description="An example plugin.">Greeter</PageTitle>
      <Button onClick={() => void greet()}>Greet me</Button>
      <p>{greeting}</p>
    </div>
  );
}

export default {
  name: "greeter",
  nav: { label: "Greeter", Page },
} satisfies WebPlugin;
