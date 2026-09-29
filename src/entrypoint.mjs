import MicrosoftGraphServer from '@softeria/ms-365-mcp-server/dist/server.js';
import { loadAttachmentConfig, registerMailAttachmentTools, startAttachmentCleanup } from './mail-attachment-tools.mjs';

const attachmentConfig = loadAttachmentConfig();
const originalCreateMcpServer = MicrosoftGraphServer.prototype.createMcpServer;
MicrosoftGraphServer.prototype.createMcpServer = function createMcpServerWithHypershellAttachments() {
  const server = originalCreateMcpServer.call(this);
  registerMailAttachmentTools(server, this.graphClient, this.options, attachmentConfig);
  return server;
};

await startAttachmentCleanup(attachmentConfig);
await import('@softeria/ms-365-mcp-server/dist/index.js');
