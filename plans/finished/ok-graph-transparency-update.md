# Plan: OK-Graph Transparency Update and Bridge Highlight Intensity

Invert the transparency slider logic (high percentage means not-transparent/fully visible) and set the default to 50%. Make cluster bridges highlight more intensively when their cluster is selected.

## Deconstruction and Subtasks

### 1. Update Component Defaults
Modify [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts):
- Change `bridgeTransparency = signal<number>(0);` to `bridgeTransparency = signal<number>(50);` (representing 50% opacity by default).
- Change `linkTransparency = signal<number>(0);` to `linkTransparency = signal<number>(50);` (representing 50% opacity by default).

### 2. Update Template Opacity Formulas
Modify [okgraph.component.html](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.html):
- Update `<path class="graph-svg__bridge">` opacity style binding to:
  `[style.opacity]="bridgeTransparency() / 100"`
- Update `<path class="graph-svg__edge">` opacity style binding to:
  `[style.opacity]="linkTransparency() / 100"`
- (Optional) Verify the labels still read nicely: since higher values mean "not-transparent" (fully visible), it effectively acts as a visibility/opacity slider.

### 3. Intensive Bridge Highlight Styling
Modify [okgraph.component.scss](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.scss):
- Increase the highlight intensity of `&--highlighted` class under `.graph-svg__bridge`:
  - `fill-opacity: 0.5`
  - `stroke-opacity: 1.0`
  - `stroke-width: 4`

### 4. Build and Test
- Run `npm run build` in `/home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend` to ensure compiler correctness.
- Run `npx ng test --watch=false` to verify that all unit tests pass.
