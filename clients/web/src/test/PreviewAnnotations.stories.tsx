import { Button } from "@mantine/core";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { theme } from "../theme/theme";

// Guard for #1898.
//
// `.storybook/vitest.setup.ts` used to call `setProjectAnnotations([...])` to
// hand the preview annotations to the Storybook vitest project. Since Storybook
// 10.3 `@storybook/addon-vitest` applies them automatically — and *skips* doing
// so when it finds such a setup file — so the file was removed and the
// `setupFiles` entry dropped from the `storybook` project in `vite.config.ts`.
//
// A green suite is not evidence that the automatic path works. Two things the
// setup file used to provision are silently losable:
//
//   • `./preview`'s decorator, which wraps every story in `MantineProvider`
//     with the project theme, and its `import "../src/App.css"`, which defines
//     the `--inspector-*` tokens. Without them stories render unthemed and
//     unstyled — and would very likely still pass their play functions.
//   • `@storybook/addon-a11y/preview`, which runs axe after each play function.
//     Without it the `a11y: { test: "error" }` parameter is inert and every
//     story passes its accessibility check vacuously.
//
// The story below closes the first gap: it asserts the Mantine theme variables
// and the `App.css` tokens are actually present in the rendered document, so an
// unthemed render fails loudly rather than passing. It also asserts the preview
// `parameters` reached the story, which is the same channel the a11y parameter
// arrives on. The axe *runner* itself can't be introspected from a play
// function; it was verified out-of-band by temporarily giving a story a real
// violation and confirming the suite went red (see the PR for #1898).

// The primary shade the theme pins for the light scheme — the value Mantine
// derives `--mantine-primary-color-filled` from. Read from the theme rather
// than hard-coded so a palette change can't silently invalidate the guard.
const LIGHT_PRIMARY_SHADE = 7;

function expectedPrimaryColor(): string {
  const palette = theme.colors?.[theme.primaryColor ?? ""];
  const color = palette?.[LIGHT_PRIMARY_SHADE];
  if (!color) throw new Error("theme is missing its primary color palette");
  return color;
}

const meta: Meta<typeof Button> = {
  title: "Meta/Preview Annotations",
  component: Button,
  args: { children: "Themed" },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const ProjectAnnotationsApplied: Story = {
  play: async ({ canvasElement, parameters }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("button", { name: "Themed" })).toBeInTheDocument();

    const root = getComputedStyle(document.documentElement);

    // `MantineProvider` (the `./preview` decorator) injects the theme's CSS
    // variables onto `:root`. No provider, no variables.
    expect(root.getPropertyValue("--mantine-primary-color-filled").trim()).toBe(
      expectedPrimaryColor(),
    );

    // `--inspector-brand-primary` is defined in `App.css`, which only reaches
    // the story through `./preview`'s stylesheet import — and it resolves
    // *through* the Mantine variable above, so this covers both layers.
    expect(root.getPropertyValue("--inspector-brand-primary").trim()).toBe(
      expectedPrimaryColor(),
    );

    // The preview `parameters` merged into the story context — the same channel
    // that carries `a11y: { test: "error" }` to the a11y addon.
    expect(parameters.a11y).toMatchObject({ test: "error" });
  },
};
