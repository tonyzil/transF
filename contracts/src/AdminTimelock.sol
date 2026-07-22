// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AdminTimelock — M-of-N owners, plus a delay before anything lands.
///
/// The privileged surface of this system is small but total: whoever owns the
/// vault can raise the daily cap, grant itself the ramp and orchestrator
/// roles, or drain the swapper's inventory. A single key holding that is one
/// compromise away from every user's balance.
///
/// This contract becomes that owner. Two properties matter:
///
///  - M-of-N: one stolen key is not enough to act.
///  - A delay: every parameter change and withdrawal is queued in public
///    before it executes, so anyone watching can see a hostile change coming
///    and any owner can cancel it.
///
/// Emergency pause is deliberately NOT routed through here — see the guardian
/// role on RemitVault and FxSwapper. Stopping the system must be instant;
/// starting it again is what deserves the delay.
contract AdminTimelock {
    struct Operation {
        address target;
        uint256 value;
        bytes data;
        uint256 eta; // earliest execution time
        uint8 confirmations;
        bool executed;
        bool cancelled;
    }

    mapping(address => bool) public isOwner;
    address[] public owners;
    uint8 public threshold;
    uint256 public delay;

    mapping(bytes32 => Operation) public operations;
    mapping(bytes32 => mapping(address => bool)) public confirmedBy;

    event Queued(bytes32 indexed id, address indexed target, bytes data, uint256 eta, address proposer);
    event Confirmed(bytes32 indexed id, address indexed owner, uint8 confirmations);
    event Executed(bytes32 indexed id, address indexed target, bytes returnData);
    event Cancelled(bytes32 indexed id, address indexed by);

    modifier onlyOwner() {
        require(isOwner[msg.sender], "not owner");
        _;
    }

    /// Only the timelock itself may change its own membership or delay — which
    /// means those changes go through the same queue-and-wait as everything.
    modifier onlySelf() {
        require(msg.sender == address(this), "only via timelock");
        _;
    }

    constructor(address[] memory _owners, uint8 _threshold, uint256 _delay) {
        require(_owners.length > 0, "no owners");
        require(_threshold > 0 && _threshold <= _owners.length, "bad threshold");
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            require(o != address(0) && !isOwner[o], "bad owner");
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = _threshold;
        delay = _delay;
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function operationId(address target, uint256 value, bytes calldata data, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, data, salt));
    }

    /// Queue a call. The proposer's own confirmation counts as the first.
    function queue(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        onlyOwner
        returns (bytes32 id)
    {
        require(target != address(0), "zero target");
        id = operationId(target, value, data, salt);
        require(operations[id].eta == 0, "already queued");
        operations[id] = Operation({
            target: target,
            value: value,
            data: data,
            eta: block.timestamp + delay,
            confirmations: 1,
            executed: false,
            cancelled: false
        });
        confirmedBy[id][msg.sender] = true;
        emit Queued(id, target, data, operations[id].eta, msg.sender);
        emit Confirmed(id, msg.sender, 1);
    }

    function confirm(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        require(op.eta != 0, "unknown operation");
        require(!op.executed && !op.cancelled, "operation closed");
        require(!confirmedBy[id][msg.sender], "already confirmed");
        confirmedBy[id][msg.sender] = true;
        op.confirmations += 1;
        emit Confirmed(id, msg.sender, op.confirmations);
    }

    /// Any single owner can cancel: refusing to act needs less authority than
    /// acting does.
    function cancel(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        require(op.eta != 0, "unknown operation");
        require(!op.executed && !op.cancelled, "operation closed");
        op.cancelled = true;
        emit Cancelled(id, msg.sender);
    }

    function execute(bytes32 id) external payable onlyOwner returns (bytes memory) {
        Operation storage op = operations[id];
        require(op.eta != 0, "unknown operation");
        require(!op.executed && !op.cancelled, "operation closed");
        require(op.confirmations >= threshold, "not enough confirmations");
        require(block.timestamp >= op.eta, "timelock not elapsed");
        op.executed = true;
        (bool ok, bytes memory ret) = op.target.call{value: op.value}(op.data);
        require(ok, "call reverted");
        emit Executed(id, op.target, ret);
        return ret;
    }

    // --- self-administration (must go through the queue) ---------------------

    function setDelay(uint256 newDelay) external onlySelf {
        delay = newDelay;
    }

    function setThreshold(uint8 newThreshold) external onlySelf {
        require(newThreshold > 0 && newThreshold <= owners.length, "bad threshold");
        threshold = newThreshold;
    }

    function addOwner(address who) external onlySelf {
        require(who != address(0) && !isOwner[who], "bad owner");
        isOwner[who] = true;
        owners.push(who);
    }

    function removeOwner(address who) external onlySelf {
        require(isOwner[who], "not an owner");
        require(owners.length - 1 >= threshold, "threshold would exceed owners");
        isOwner[who] = false;
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == who) {
                owners[i] = owners[owners.length - 1];
                owners.pop();
                break;
            }
        }
    }

    receive() external payable {}
}
