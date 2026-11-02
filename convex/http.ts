import { httpRouter } from "convex/server";
import { auth } from "./auth";
import {
  httpAddTasks,
  httpComment,
  httpCreateProject,
  httpGetProject,
  httpAddBriefLinks,
  httpDeleteComment,
  httpMoveComment,
  httpUpdateComment,
  httpDeleteTask,
  httpEditLines,
  httpReplaceDocument,
  httpListVersions,
  httpRemoveBriefLinks,
  httpRestoreVersion,
  httpAddReferences,
  httpListReferences,
  httpListBoards,
  httpCreateBoard,
  httpAddToBoard,
  httpEditBoard,
  httpGetBoard,
  httpAddUpdate,
  httpListProjects,
  httpSetBrief,
  httpUpdateTask,
  httpSuggestEdit,
  httpUpdateProject,
  httpPinBoard,
  httpListClubs,
  httpGetClub,
  httpCreateClub,
  httpUpdateClub,
  httpListReviews,
  httpGetReview,
  httpStartReview,
  httpAddReviewRound,
  httpMarkReview,
  httpResolveMark,
  httpReviewStatus,
  httpApproveReview,
  httpPinProject,
  httpListFfeProducts,
  httpGetFfeProduct,
  httpAddFfeProduct,
  httpUpdateFfeProduct,
  httpPlaceFfe,
  httpListFfe,
  httpRemoveFfePlacement,
  httpAttach,
  httpFile,
  httpUploadUrl,
} from "./agent";
import { help } from "./agentHelp";
import { mcpGet, mcpPost } from "./mcp";

const http = httpRouter();
auth.addHttpRoutes(http);

// Agent API (bearer AGENT_API_KEY). See convex/agent.ts for what each route may change.
// The paths here and the MCP tool names in convex/mcp.ts are two separate contracts with no shared
// constant: rename one and you must rename the other, or the guide starts lying to agents.
http.route({ path: "/agent/help", method: "GET", handler: help });
http.route({ path: "/agent/projects", method: "GET", handler: httpListProjects });
http.route({ path: "/agent/project", method: "GET", handler: httpGetProject });
http.route({ path: "/agent/projects", method: "POST", handler: httpCreateProject });
http.route({ path: "/agent/project/update", method: "POST", handler: httpUpdateProject });
http.route({ path: "/agent/suggest", method: "POST", handler: httpSuggestEdit });
http.route({ path: "/agent/tasks", method: "POST", handler: httpAddTasks });
http.route({ path: "/agent/task", method: "POST", handler: httpUpdateTask });
http.route({ path: "/agent/task/delete", method: "POST", handler: httpDeleteTask });
http.route({ path: "/agent/brief", method: "POST", handler: httpSetBrief });
http.route({ path: "/agent/brief-links", method: "POST", handler: httpAddBriefLinks });
http.route({ path: "/agent/brief-links/delete", method: "POST", handler: httpRemoveBriefLinks });
http.route({ path: "/agent/update", method: "POST", handler: httpAddUpdate });
http.route({ path: "/agent/comment", method: "POST", handler: httpComment });
http.route({ path: "/agent/comment/attach", method: "POST", handler: httpAttach });
http.route({ path: "/agent/comment/move", method: "POST", handler: httpMoveComment });
http.route({ path: "/agent/comment/update", method: "POST", handler: httpUpdateComment });
http.route({ path: "/agent/comment/delete", method: "POST", handler: httpDeleteComment });
http.route({ path: "/agent/upload-url", method: "POST", handler: httpUploadUrl });
http.route({ path: "/agent/file", method: "POST", handler: httpFile });
http.route({ path: "/agent/replace", method: "POST", handler: httpReplaceDocument });
http.route({ path: "/agent/edit-lines", method: "POST", handler: httpEditLines });
http.route({ path: "/agent/versions", method: "GET", handler: httpListVersions });
http.route({ path: "/agent/restore", method: "POST", handler: httpRestoreVersion });
http.route({ path: "/agent/pin", method: "POST", handler: httpPinProject });
http.route({ path: "/agent/references", method: "GET", handler: httpListReferences });
http.route({ path: "/agent/references", method: "POST", handler: httpAddReferences });
http.route({ path: "/agent/clubs", method: "GET", handler: httpListClubs });
http.route({ path: "/agent/club", method: "GET", handler: httpGetClub });
http.route({ path: "/agent/clubs", method: "POST", handler: httpCreateClub });
http.route({ path: "/agent/club", method: "POST", handler: httpUpdateClub });
http.route({ path: "/agent/reviews", method: "GET", handler: httpListReviews });
http.route({ path: "/agent/review", method: "GET", handler: httpGetReview });
http.route({ path: "/agent/reviews", method: "POST", handler: httpStartReview });
http.route({ path: "/agent/review/round", method: "POST", handler: httpAddReviewRound });
http.route({ path: "/agent/review/mark", method: "POST", handler: httpMarkReview });
http.route({ path: "/agent/review/mark/resolve", method: "POST", handler: httpResolveMark });
http.route({ path: "/agent/review/status", method: "POST", handler: httpReviewStatus });
http.route({ path: "/agent/review/approve", method: "POST", handler: httpApproveReview });
http.route({ path: "/agent/ffe/products", method: "GET", handler: httpListFfeProducts });
http.route({ path: "/agent/ffe/product", method: "GET", handler: httpGetFfeProduct });
http.route({ path: "/agent/ffe/products", method: "POST", handler: httpAddFfeProduct });
http.route({ path: "/agent/ffe/product", method: "POST", handler: httpUpdateFfeProduct });
http.route({ path: "/agent/ffe", method: "GET", handler: httpListFfe });
http.route({ path: "/agent/ffe/place", method: "POST", handler: httpPlaceFfe });
http.route({ path: "/agent/ffe/remove", method: "POST", handler: httpRemoveFfePlacement });
http.route({ path: "/agent/boards", method: "GET", handler: httpListBoards });
http.route({ path: "/agent/board", method: "GET", handler: httpGetBoard });
http.route({ path: "/agent/board/create", method: "POST", handler: httpCreateBoard });
http.route({ path: "/agent/board/add", method: "POST", handler: httpAddToBoard });
http.route({ path: "/agent/board/edit", method: "POST", handler: httpEditBoard });
http.route({ path: "/agent/board/pin", method: "POST", handler: httpPinBoard });

// MCP server (same key, same safe operations), for tools that hold the key as a connected account.
http.route({ path: "/mcp", method: "POST", handler: mcpPost });
http.route({ path: "/mcp", method: "GET", handler: mcpGet });

export default http;
