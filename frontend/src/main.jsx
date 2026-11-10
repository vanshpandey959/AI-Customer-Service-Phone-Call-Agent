import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import AdminPage from "./admin/AdminPage.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AdminPage />
  </StrictMode>
);
