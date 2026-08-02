# UI prototype

Use this shape when the question is what a page, component, or interaction should look and feel like. The user should be able to compare structural alternatives in the context where the design will actually live.

If the uncertainty is about state or business logic, use [LOGIC.md](LOGIC.md) instead.

## Prefer an existing page

Use one of these shapes, strongly preferring the first:

- **Existing page:** keep the route, data loading, parameters, and auth intact; swap only the rendered area using a `?variant=` search parameter.
- **New page:** only when the design has no sensible host. Follow the project's router and put the route under an obviously disposable prototype path or filename.

An isolated mock often hides density and hierarchy problems. Before creating a new route, check whether the experiment belongs inside an existing dashboard, settings page, or flow.

## Process

### 1. State the question and count the variants

Default to three variants and never exceed five. Write a one-line plan at the prototype location or top of the file, for example: “Three settings layouts on `/settings`, selected with `?variant=`.”

### 2. Make the variants disagree structurally

Keep each option faithful to the page's purpose, available data, component library, and styling system. Give each a clear component name. Change the layout, hierarchy, or primary affordance—not just colors and copy. If two options start looking alike, redesign one around a different organizing idea.

### 3. Add one switcher

Render the selected variant from the URL and keep the existing data fetching above the switch point:

```tsx
const variant = searchParams.get('variant') ?? 'A';

return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A', 'B', 'C']} current={variant} />
  </>
);
```

For a new page, mount the same switcher under the disposable prototype route. Keep the variants free to make different layout choices; share only genuinely common pieces.

### 4. Build the floating control

Put a small fixed bar at the bottom centre with:

- a previous arrow that wraps around;
- the current key and optional variant name;
- a next arrow that wraps around.

Clicks and left/right arrow keys should update the URL through the host router, making every option linkable and stable on reload. Do not capture arrow keys while an input, textarea, or contenteditable element has focus. Make the bar visually separate from the design under evaluation, and hide it from production builds.

### 5. Hand it over

Give the user the route and the available `?variant=` keys. Their comparisons—such as combining the header from one option with the navigation from another—are the design feedback to capture.

### 6. Capture and clean up

Record which option won and why. Promote the winning design into proper production code, then remove the switcher and losing variants from the main branch. Preserve the full experiment on the throwaway branch as the primary source, so the comparison remains available without leaving disposable code in production.

## Avoid

- Calling color or copy changes separate variants.
- Sharing a layout abstraction so broadly that the options cannot differ.
- Wiring the experiment to real mutations; use stubs for a visual question.
- Promoting prototype components directly into production without a proper rewrite.
