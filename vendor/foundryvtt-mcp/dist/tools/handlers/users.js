/**
 * User management tool handler
 */
import { withToolError } from './utils.js';
const ROLE_NAMES = {
    0: 'None',
    1: 'Player',
    2: 'Trusted Player',
    3: 'Assistant GM',
    4: 'Game Master',
};
export async function handleGetUsers(_args, foundryClient) {
    return withToolError('get users', async () => {
        const { users, activeUsers } = foundryClient.getUsers();
        const activeSet = new Set(activeUsers);
        const formatted = users
            .map((u) => {
            const online = activeSet.has(u._id) ? 'Online' : 'Offline';
            const role = ROLE_NAMES[u.role] || `Role ${u.role}`;
            return `- **${u.name}** (${role}) — ${online}`;
        })
            .join('\n');
        const onlineCount = users.filter((u) => activeSet.has(u._id)).length;
        return {
            content: [
                {
                    type: 'text',
                    text: `**Users** (${onlineCount}/${users.length} online)\n\n${formatted}`,
                },
            ],
        };
    });
}
//# sourceMappingURL=users.js.map