// Script interactively adds new accounts.
// Run: node scripts/core/addAccount.js

import { interactiveAccountMenu } from '../../src/utils/accountSetup.js';

(async () => {
    await interactiveAccountMenu();
})();
