import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  cssVariables: true,
  shape: {
    borderRadius: 28
  },
  palette: {
    mode: "light",
    primary: {
      main: "#2f6f67",
      light: "#d7efe8",
      dark: "#173a35",
      contrastText: "#173a35"
    },
    secondary: {
      main: "#8c6a2f",
      light: "#f4e6c8",
      dark: "#5b4319"
    },
    background: {
      default: "#edf2ef",
      paper: "#fcfdfb"
    },
    divider: "rgba(24, 45, 41, 0.12)",
    success: {
      main: "#196b2e"
    },
    text: {
      primary: "#16211e",
      secondary: "#62716c"
    }
  },
  typography: {
    fontFamily: '"Segoe UI Variable", "Segoe UI", "Noto Sans SC", sans-serif',
    body1: {
      lineHeight: 1.6
    },
    body2: {
      lineHeight: 1.5
    },
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
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 18,
          textTransform: "none",
          fontWeight: 600
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 16
        }
      }
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined"
      }
    }
  }
});
