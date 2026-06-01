# Subtask: Render Spindle-Shaped (Double-Pointed) Merge Bridges

Modify the merge bridge geometry so that the bridges start as a single point, expand smoothly to their maximum thickness in the middle, and then shrink back to a single point at the other end.

## Steps to Implement

### 1. Update Ribbon Path Geometry
Modify the `ribbonPath()` function in [okgraph.component.ts](file:///home/juhasz/Desktop/Projects/Open_Knowledge/Repo/frontend/src/app/features/okgraph/okgraph.component.ts) to define a spindle shape:
- Start the path at `(p0.x, p0.y)` (width 0).
- Curve the left boundary outwards using control points `(p0.x - hw, cy)` and `(p1.x - hw, cy)`, ending at `(p1.x, p1.y)`.
- Curve the right boundary outwards using control points `(p1.x + hw, cy)` and `(p0.x + hw, cy)`, returning to `(p0.x, p0.y)`.

### 2. Verify and Test
- Compile the frontend project using `npm run build`.
- Run the frontend tests via `npx ng test --watch=false` to confirm all tests pass successfully.
