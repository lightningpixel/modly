/**
 * Test-only entry point. Never imported by the app.
 *
 * The React test env bundles the module under test, so a store imported
 * separately by the test file would be a second copy with its own state.
 * Re-exporting both from one entry guarantees the test drives exactly the
 * store the component reads.
 */
export { default } from './ConversationSidebar'
export { useChatStore as __chat } from '@shared/stores/chatStore'
