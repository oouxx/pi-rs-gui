import { Routes, Route, Navigate } from "react-router-dom"
import AppShell from "./components/AppShell"
import { ToastProvider } from "./components/ui/toast"

export default function App() {
  return (
    <ToastProvider>
      <div className="bg-background min-h-screen">
        <Routes>
          <Route path="/" element={<AppShell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </ToastProvider>
  )
}
