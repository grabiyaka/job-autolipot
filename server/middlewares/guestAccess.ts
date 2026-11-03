import { rolesAccess } from './rolesAccess.js';

export const guestAccess = rolesAccess('admin', 'manager', 'guest');
