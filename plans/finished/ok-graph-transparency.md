# Plan: OK-Graph Transparency Controls and Bridge Selection Highlighting

Implement transparency controls for cluster bridges and node links, and highlight a cluster's bridges more strongly when that cluster is selected.

## Deconstruction and Subtasks

### 1. Update Component State
Modify [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts):
- Add `bridgeTransparency = signal<number>(0);` where `0` means 0% transparent (fully visible/opaque) and `100` means 100% transparent (invisible).
- Add `linkTransparency = signal<number>(0);` with the same range.
- Implement helper method `isBridgeHighlighted(bridge: Bridge): boolean` which returns `true` if `selectedClusterId()` matches one of the two top-level clusters connected by the bridge (parsed/determined from `bridge.key`).

### 2. Update Template Bindings
Modify [okgraph.component.html](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.html):
- Add a new "Transparency" section in the display settings panel (the gear icon dropdown) containing:
  - A slider for **Bridge Transparency** (0% to 100%, step 5, bound to `bridgeTransparency`).
  - A slider for **Link Transparency** (0% to 100%, step 5, bound to `linkTransparency`).
- Apply `[style.opacity]="1 - bridgeTransparency() / 100"` to the `<path class="graph-svg__bridge">`.
- Apply `[style.opacity]="1 - linkTransparency() / 100"` to the `<path class="graph-svg__edge">`.
- Add conditional class binding `[class.graph-svg__bridge--highlighted]="isBridgeHighlighted(bridge)"` to the bridge paths.

### 3. Style Sliders and Highlighted Bridges
Modify [okgraph.component.scss](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.scss):
- Add slider row, slider header/info, label, value, and range-input styling inside `.graph-settings` block.
- Add `&--highlighted` class under `.graph-svg__bridge` to visually highlight bridges (e.g., increase fill-opacity and stroke-opacity, and slightly increase stroke-width).

### 4. Build and Test
- Run `npm run build` in `/home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend` to ensure compiler correctness.
- Run `npx ng test --watch=false` to verify that no regressions were introduced.
