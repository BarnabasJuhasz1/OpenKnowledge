# Subtask: Visually clean merge bridges in OK-Graph using linear gradients

Improve the visual rendering of the merge bridges between different clusters in the OK-Graph tab to make the merging visually less chaotic. Each bridge should use a custom linear gradient transitioning between the colors of the two clusters it connects, with solid ends that blend seamlessly into the clusters.

## Steps to Implement

### 1. Update the Bridge Interface
Modify the `Bridge` interface in [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts) to carry coordinates and the start/end colors of the two clusters connected by the bridge:
- Add `x1: number;` and `y1: number;`
- Add `x2: number;` and `y2: number;`
- Add `colorStart: string;` and `colorEnd: string;`

### 2. Update Bridge Construction Logic
Update the `buildBridges()` function in [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts):
- For the selected pair of connected sub-clusters `sa` and `sb`, retrieve their representative papers `repA` and `repB`.
- Find the respective top-level clusters they belong to using `topComm[repA]` and `topComm[repB]`.
- Map the top-level clusters to their actual colors via `this.clusterColorFor(topA)` and `this.clusterColorFor(topB)`.
- Pass these coordinate points and color values into the `Bridge` objects generated.

### 3. Update the SVG Template for Gradients
Modify [okgraph.component.html](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.html):
- Add a `<defs>` section under the `<svg class="graph-svg">` element.
- Loop over `bridges()` inside `<defs>` using `@for` to generate a `<linearGradient>` for each bridge:
  - Set the `id` of each gradient to `'bridge-grad-' + bridge.key`.
  - Bind `x1`, `y1`, `x2`, `y2` from the bridge coordinates.
  - Set `gradientUnits="userSpaceOnUse"`.
  - Add color stops:
    - Offset `0%` to `30%`: `bridge.colorStart` (solid start color to match cluster A)
    - Offset `70%` to `100%`: `bridge.colorEnd` (solid end color to match cluster B)
    - In between (`30%` to `70%`), a smooth gradient transition will naturally occur.
- Update the `<path class="graph-svg__bridge">` rendering to use the dynamic linear gradient:
  - `[attr.fill]="'url(#bridge-grad-' + bridge.key + ')'"`
  - `[attr.stroke]="'url(#bridge-grad-' + bridge.key + ')'"`

### 4. Build and Test
- Verify that the frontend compiles cleanly by running `npm run build` in the frontend directory.
- Verify tests pass by running `npm run test` in the frontend directory.
