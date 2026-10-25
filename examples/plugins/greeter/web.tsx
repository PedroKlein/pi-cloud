import { Button, PageTitle } from "@pi-cloud/ui";
import { useState } from "react";

function Page() {
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const response = await fetch("/api/plugins/greeter/greeting");
    setGreeting((await response.json()).greeting);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <PageTitle description="An example plugin.">Greeter</PageTitle>
      <Button onClick={greet}>Greet me</Button>
      <p>{greeting}</p>
    </div>
  );
}

export default { name: "greeter", nav: { label: "Greeter", Page } };
