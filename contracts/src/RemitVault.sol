// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @title RemitVault — per-user custody of one currency token (EURe for the
/// launch corridor). Deposits are credited by the ramp role (the Monerium
/// adapter, after a SEPA transfer mints EURe to this vault). Debits are made
/// by the orchestrator role when a user sends a remittance, subject to a
/// per-user daily cap and a global pause.
///
/// FP4: holding the orchestrator role is no longer enough to move a user's
/// money. Every debit must carry an EIP-712 PaymentAuthorization signed by the
/// account's registered authorizer — the key that lives on the user's device,
/// never on our server. The orchestrator role now only says who may *submit*
/// (and pay gas for) an already-authorized payment.
///
/// The authorizer may be an EOA (secp256k1, verified with ecrecover) or a
/// contract wallet (verified with EIP-1271), so a passkey-owned Safe can
/// replace the device key later without touching this contract.
contract RemitVault {
    IERC20 public immutable token;
    address public owner;
    bool public paused;

    /// Max a single user may send per UTC day (in token units).
    uint256 public dailyCap;

    mapping(address => bool) public isRamp;
    mapping(address => bool) public isOrchestrator;
    mapping(address => uint256) public balanceOf;
    /// user => day index => amount debited that day
    mapping(address => mapping(uint256 => uint256)) public debitedOnDay;
    /// transferId => already processed (idempotency at the contract layer)
    mapping(bytes32 => bool) public processedTransfer;
    /// deposit ref => already processed (idempotency at the contract layer)
    mapping(bytes32 => bool) public processedDeposit;
    /// account => the key allowed to authorize debits from it.
    mapping(address => address) public authorizerOf;

    /// EIP-712 domain, bound to this contract and chain so an authorization
    /// cannot be replayed against another deployment.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PAYMENT_TYPEHASH =
        keccak256("PaymentAuthorization(address account,uint256 amount,address to,bytes32 transferId,uint256 deadline)");
    bytes32 private immutable DOMAIN_SEPARATOR;

    event Deposited(address indexed user, uint256 amount, bytes32 indexed ref);
    event Debited(address indexed user, uint256 amount, address indexed to, bytes32 indexed transferId);
    event Paused(bool paused);
    event AuthorizerSet(address indexed account, address indexed authorizer, address indexed setBy);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(address _token, uint256 _dailyCap) {
        token = IERC20(_token);
        owner = msg.sender;
        dailyCap = _dailyCap;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("RemitVault"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// Bind an account to the key that may authorize its debits.
    ///
    /// First write is trust-on-first-use by the ramp role: at onboarding the
    /// device sends up its public address and we record it. After that only
    /// the current authorizer can rotate it — the owner, the ramp and the
    /// orchestrator all lose the ability to re-point an account at a key they
    /// control, which is what stops this from being theatre.
    function setAuthorizer(address account, address authorizer) external {
        require(account != address(0) && authorizer != address(0), "zero address");
        address current = authorizerOf[account];
        if (current == address(0)) {
            require(isRamp[msg.sender], "not ramp");
        } else {
            require(msg.sender == current, "not current authorizer");
        }
        authorizerOf[account] = authorizer;
        emit AuthorizerSet(account, authorizer, msg.sender);
    }

    /// The EIP-712 digest a device signs to authorize one payment.
    function paymentDigest(
        address account,
        uint256 amount,
        address to,
        bytes32 transferId,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(PAYMENT_TYPEHASH, account, amount, to, transferId, deadline));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// Verify `signature` over `digest` for `signer` — ecrecover for an EOA,
    /// EIP-1271 for a contract wallet (e.g. a passkey-owned Safe).
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) = signer.staticcall(
                abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature)
            );
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Reject the malleable upper-range s per EIP-2.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    function setRamp(address who, bool enabled) external onlyOwner {
        isRamp[who] = enabled;
    }

    function setOrchestrator(address who, bool enabled) external onlyOwner {
        isOrchestrator[who] = enabled;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    function setDailyCap(uint256 cap) external onlyOwner {
        dailyCap = cap;
    }

    /// Credit a user after fiat arrived and tokens were minted to this vault.
    /// `ref` is the off-chain payment reference (e.g. SEPA end-to-end id hash).
    function creditDeposit(address user, uint256 amount, bytes32 ref) external notPaused {
        require(isRamp[msg.sender], "not ramp");
        require(user != address(0), "zero user");
        require(amount > 0, "zero amount");
        require(!processedDeposit[ref], "duplicate deposit");
        processedDeposit[ref] = true;
        // The credited ledger total must be covered by tokens actually held.
        require(token.balanceOf(address(this)) >= totalCredited + amount, "uncovered credit");
        totalCredited += amount;
        balanceOf[user] += amount;
        emit Deposited(user, amount, ref);
    }

    uint256 public totalCredited;

    /// Debit a user's balance for an outbound remittance and move the tokens
    /// to `to` (the orchestrator's working address for the swap leg).
    ///
    /// `signature` is the account authorizer's EIP-712 PaymentAuthorization
    /// over exactly these terms. Holding the orchestrator role lets you submit
    /// a payment the user authorized; it does not let you invent one.
    function debit(
        address user,
        uint256 amount,
        address to,
        bytes32 transferId,
        uint256 deadline,
        bytes calldata signature
    ) external notPaused {
        require(isOrchestrator[msg.sender], "not orchestrator");
        require(!processedTransfer[transferId], "duplicate transfer");
        require(balanceOf[user] >= amount, "insufficient balance");

        address authorizer = authorizerOf[user];
        require(authorizer != address(0), "no authorizer");
        require(block.timestamp <= deadline, "authorization expired");
        require(
            _isValidSignature(authorizer, paymentDigest(user, amount, to, transferId, deadline), signature),
            "bad authorization"
        );

        uint256 day = block.timestamp / 1 days;
        require(debitedOnDay[user][day] + amount <= dailyCap, "daily cap exceeded");

        processedTransfer[transferId] = true;
        debitedOnDay[user][day] += amount;
        balanceOf[user] -= amount;
        totalCredited -= amount;

        require(token.transfer(to, amount), "token transfer failed");
        emit Debited(user, amount, to, transferId);
    }
}
