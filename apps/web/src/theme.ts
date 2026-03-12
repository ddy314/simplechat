import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  cssVariables: true,
  shape: {
    borderRadius: 24
  },
  palette: {
    mode: "light",
    primary: {
      main: "#006a6a"
    },
    secondary: {
      main: "#825500"
    },
    background: {
      default: "#f6f3ee",
      paper: "#fffdf8"
    },
    success: {
      main: "#196b2e"
    }
  },
  typography: {
    fontFamily: '"Segoe UI", "Noto Sans SC", sans-serif',
    h4: {
      fontWeight: 700
    },
    h5: {
      fontWeight: 700
    },
    h6: {
      fontWeight: 700
    }
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none"
        }
      }
    }
  }
});

