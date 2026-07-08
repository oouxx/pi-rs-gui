import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { AppModeProvider } from "./contexts/AppModeContext"
import AppShell from "./components/AppShell"

export default function App() {
  return (
    <AppModeProvider>
      <div className="bg-background min-h-screen">
        <Routes>
          <Route path="/" element={<AppShell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </AppModeProvider>
  )
}
