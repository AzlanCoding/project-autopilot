import express, { Application } from 'express';
import * as path from 'path';
import { Request, Response, NextFunction } from 'express';

/**
 * Service layer for managing the Web Console interface.
 * Handles administrative tasks for Project Autopilot by hosting secure API endpoints.
 */
export class WebConsoleService {
    private readonly app: Application;
    private _isAuthenticated: boolean = false;
    private _currentUser: string | null = null;

    /**
     * Initializes the service by setting up the Express application and routes.
     * @param expressApp An existing Express application instance to attach routes to. If null, a new, isolated Express app will be created.
     */
    constructor(expressApp?: Application) {
        if (expressApp) {
            this.app = expressApp;
        } else {
            this.app = express();
            // Setup middleware for new instances
            this.app.use(express.json());

            // *** NEW: Serve static web console page ***
            const staticPath = path.join(__dirname, '../static');
            this.app.use(express.static(staticPath));
        }
        this._setupRoutes();
        console.log("✅ WebConsoleService initialized and Express routes configured.");
    }

    private _setupRoutes() {
        // Middleware to parse JSON bodies (This might be redundant if done in constructor, but kept for explicit route setup clarity)
        this.app.use(express.json());

        // --- Authentication Routes ---
        this.app.post('/api/admin/login', this.handleLogin.bind(this));

        // --- Protected Routes ---
        this.app.get('/api/admin/status', this.authenticateMiddleware('getBotStatus'));
        this.app.post('/api/admin/sticker/approve', this.authenticateMiddleware('approveSticker'));
        this.app.get('/api/admin/logs', this.authenticateMiddleware('viewConversationLogs'));
    }

    /**
     * Middleware to check authentication before allowing access to protected routes.
     * @param methodToCall The method name on the service instance to call upon success.
     * @returns Express router middleware function.
     */
    private authenticateMiddleware<T extends keyof WebConsoleService>(methodToCall: T) {
        return async (req: Request, res: Response, next: NextFunction) => {
            if (!this._isAuthenticated || !this._currentUser) {
                return res.status(401).json({ success: false, message: "Unauthorized. Please log in first." });
            }
            // Attach the successful service method call to the request object for subsequent handlers
            (req as any).serviceMethod = (this[methodToCall] as any).bind(this);
            next();
        };
    }

    // --- Public/Authentication Methods ---

    /**
     * Handles the login request POST endpoint.
     */
    private async handleLogin(req: Request, res: Response) {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username and password are required." });
        }

        const success = await this.login(username, password);
        if (success) {
            res.status(200).json({ success: true, message: "Login successful. You can now access admin endpoints." });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials." });
        }
    }

    /**
     * Attempts to log into the web console using credentials from environment variables.
     */
    public async login(username: string, passwordAttempt: string): Promise<boolean> {
        const requiredPassword = process.env.CONSOLE_SECRET_PASSWORD;

        if (!requiredPassword) {
            console.error("[AUTH FAILED] CRITICAL: CONSOLE_SECRET_PASSWORD environment variable is not set. Login impossible.");
            return false;
        }

        if (requiredPassword === passwordAttempt) {
            this._isAuthenticated = true;
            this._currentUser = username;
            console.log(`
👑 [SUCCESS] Web Console User '${username}' authenticated successfully.`);
            return true;
        } else {
            console.warn(`
❌ [AUTH FAILED] Invalid password attempt for user: ${username}`);
            this._isAuthenticated = false;
            this._currentUser = null;
            return false;
        }
    }

    // --- Protected Service Logic ---

    public async approveSticker(stickerId: string): Promise<boolean> {
        if (!this._isAuthenticated) throw new Error("Unauthorized access.");
        console.log(`[SERVICE CALL] Attempting to approve sticker: ${stickerId}`);
        // --- PLACEHOLDER LOGIC ---
        return true;
    }

    public getBotStatus(): { status: string, uptime: string, lastError: string | null } {
        console.log("[SERVICE CALL] Retrieving bot status.");
        // --- PLACEHOLDER LOGIC ---
        return { status: "OPERATIONAL", uptime: "N/A", lastError: null };
    }

    public async viewConversationLogs(jid: string, limit: number = 50): Promise<any[]> {
        if (!this._isAuthenticated) throw new Error("Unauthorized access.");
        console.log(`[SERVICE CALL] Fetching ${limit} logs for JID: ${jid}`);
        // --- PLACEHOLDER LOGIC ---
        return [{ sender: "System", content: `Log fetching placeholder for ${jid}` }];
    }
}

// ====================================================================================
// === SERVER INITIALIZATION BLOCK ===
// ACTION REQUIRED: Place this execution logic in your main server entry point file (e.g., server.ts).
// =================================================================================================

// 1. Ensure 'express' is installed: npm install express
// 2. Set environment variable: export CONSOLE_SECRET_PASSWORD='YourRealPassword'
// 3. Initialize and start the service:
// const webConsoleService = new WebConsoleService();
// const PORT = process.env.WEB_CONSOLE_PORT || 3001;
// webConsoleService.app.listen(PORT, () => {
//     console.log(`
// =============================================
// 🚀 Web Console API running successfully on http://localhost:${PORT}
// ===============================================
// `);
// });
