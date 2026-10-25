export default {
  name: "greeter",
  extension: (cloud) => (pi) => {
    pi.registerCommand("greet", {
      description: "Say the greeting from the Greeter plugin's settings",
      handler: async (_args, ctx) => {
        const response = await cloud.request("greeting");
        const { greeting } = await response.json();

        ctx.ui.notify(`${greeting} from ${ctx.cwd}`, "info");
      },
    });
  },
};
