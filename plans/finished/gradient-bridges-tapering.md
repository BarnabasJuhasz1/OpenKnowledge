# Subtask: Taper OK-Graph merge bridges to a single point

Modify the merge bridge geometry so that the bridges shrink drastically and end in a single point at the newer (right-most) cluster, creating a visually elegant flow from past to future.

## Steps to Implement

### 1. Update Ribbon Path Function
Modify the `ribbonPath()` function in [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts):
- Identify the starting node (older, left-most) and ending node (newer, right-most) based on `x` coordinates.
- Start the path at the starting node with a half-width `hw = 24` (`start.x - hw` and `start.x + hw`).
- Construct the curves so they meet exactly at `(end.x, end.y)`, representing a single point of width `0` at the ending node.

### 2. Update Bridge Construction Logic
Ensure that in `buildBridges()`, the linear gradient coordinates (`x1, y1` and `x2, y2`) and start/end colors (`colorStart` and `colorEnd`) are also sorted from left-to-right (older to newer) to align perfectly with the tapering path geometry.

### 3. Verify and Test
- Compile the frontend project using `npm run build`.
- Run the frontend tests via `npx ng test --watch=false` to confirm everything is working correctly.
