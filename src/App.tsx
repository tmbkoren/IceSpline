import { CanvasView } from "./canvas/CanvasView";
import { ControlPanel } from "./ui/ControlPanel";
import { ActionDock } from "./ui/ActionDock";

export default function App() {
  return (
    <>
      <CanvasView />
      <ControlPanel />
      <ActionDock />
    </>
  );
}