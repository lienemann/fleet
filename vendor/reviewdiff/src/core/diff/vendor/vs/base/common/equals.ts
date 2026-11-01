/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// reviewdiff: trimmed to the declarations used by the vendored diff code; every kept declaration is verbatim upstream.

export interface IEquatable<T> {
	equals(other: T): boolean;
}
