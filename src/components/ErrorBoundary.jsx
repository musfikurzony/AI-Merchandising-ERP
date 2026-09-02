import React from "react";

/* Confirmed root cause of "Reports Center goes blank and browser Back stops
   working": there was no error boundary anywhere in this app. React
   unmounts the ENTIRE component tree on any uncaught render error --
   not just the one screen that failed -- which is exactly why browser
   navigation stopped responding too (React Router needs a mounted tree
   to react to history changes at all). This isn't a workaround for one
   bug; it's the correct containment for any future one. A caught error
   here shows a recoverable message and keeps the rest of the app usable,
   rather than a permanently blank page. */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("Caught by ErrorBoundary:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, maxWidth: 560 }}>
          <h2 style={{ color: "#B91C1C" }}>Something went wrong on this page</h2>
          <p className="muted-sm">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn-primary" onClick={() => { this.setState({ hasError: false, error: null }); window.history.back(); }}>← Go Back</button>
            <button className="btn-ghost-sm" onClick={() => window.location.reload()}>Reload Page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
