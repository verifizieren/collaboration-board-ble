package nz.scuttlebutt.tremola.ssb.db.entities

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index

@Entity(
    tableName = "BoardOperation",
    primaryKeys = ["room_id", "operation_id"],
    indices = [
        Index(value = ["room_id", "author_id", "author_seq"], unique = true),
        Index(value = ["room_id", "event_time"])
    ]
)
data class BoardOperation(
    @ColumnInfo(name = "operation_id") val operationId: String,
    @ColumnInfo(name = "room_id") val roomId: String,
    @ColumnInfo(name = "author_id") val authorId: String,
    @ColumnInfo(name = "author_seq") val authorSequence: Int,
    @ColumnInfo(name = "event_time") val eventTime: Long,
    @ColumnInfo(name = "wire_json") val wireJson: String,
    @ColumnInfo(name = "received_at") val receivedAt: Long
)
